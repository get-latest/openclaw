/**
 * Compaction Guard Plugin
 *
 * Preserves task context across memory compaction events.
 *
 * Problem: When Pi auto-compaction runs mid-task, the agent loses working
 * context and doesn't know what it was doing ("stroke" effect).
 *
 * Solution:
 * 1. `before_compaction` — Extract and save current task state
 * 2. `after_compaction` — Mark that recovery is needed
 * 3. `before_agent_start` — Inject recovery context if compaction just happened
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CompactionGuardConfig = {
  contextFile?: string;
  recoveryPrompt?: boolean;
  minMessagesForSnapshot?: number;
};

// State tracking
const state = {
  compactionJustHappened: false,
  lastCompactionTime: 0,
  compactionCount: 0,
  savedContext: null as string | null,
};

function resolveContextPath(config: CompactionGuardConfig): string {
  const workspace =
    process.env.OPENCLAW_WORKSPACE ?? path.join(os.homedir(), ".openclaw/workspace");
  const defaultPath = path.join(workspace, "memory", "compaction-context.md");

  if (!config.contextFile) {
    return defaultPath;
  }

  if (config.contextFile.startsWith("~/")) {
    return path.join(os.homedir(), config.contextFile.slice(2));
  }

  if (path.isAbsolute(config.contextFile)) {
    return config.contextFile;
  }

  return path.join(workspace, config.contextFile);
}

async function extractTaskContext(messages: unknown[]): Promise<string | null> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  // Look at recent messages to understand current task
  const recentMessages = messages.slice(-20);
  const contextParts: string[] = [];

  for (const msg of recentMessages) {
    if (!msg || typeof msg !== "object") continue;

    const role = (msg as { role?: string }).role;
    const content = (msg as { content?: unknown }).content;

    if (role === "user" && typeof content === "string") {
      // User messages often contain the task
      const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
      contextParts.push(`User: ${truncated}`);
    } else if (role === "assistant") {
      // Look for task indicators in assistant messages
      const text = extractTextContent(content);
      if (text) {
        // Check for task-related patterns
        if (/working on|creating|building|fixing|implementing|investigating/i.test(text)) {
          const truncated = text.length > 300 ? text.slice(0, 300) + "..." : text;
          contextParts.push(`Assistant: ${truncated}`);
        }
      }
    }
  }

  if (contextParts.length === 0) {
    return null;
  }

  return contextParts.slice(-5).join("\n\n");
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const rec = block as { type?: string; text?: string };
        if (rec.type === "text" && typeof rec.text === "string") {
          textParts.push(rec.text);
        }
      }
    }
    return textParts.join("\n") || null;
  }

  return null;
}

async function saveContext(
  contextPath: string,
  context: string,
  compactionCount: number,
): Promise<void> {
  const content = `# Compaction Recovery Context

*Auto-saved at: ${new Date().toISOString()}*
*Compaction #${compactionCount}*

## Recent Activity

${context}

---

**Note:** This context was automatically saved before memory compaction.
If you're reading this, compaction just ran. Review the above to understand
what was happening before context was compressed.
`;

  await fs.mkdir(path.dirname(contextPath), { recursive: true });
  await fs.writeFile(contextPath, content, "utf-8");
}

async function loadContext(contextPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(contextPath, "utf-8");
    return content;
  } catch {
    return null;
  }
}

async function clearContext(contextPath: string): Promise<void> {
  try {
    await fs.unlink(contextPath);
  } catch {
    // File may not exist, that's fine
  }
}

const RECOVERY_PROMPT = `
## ⚠️ COMPACTION RECOVERY

Memory compaction just ran. Your previous context was compressed.

**What to do:**
1. Check \`memory/compaction-context.md\` for saved task state
2. Check \`memory/session-context.md\` for current task info
3. If mid-task, review what you were doing and continue
4. If unclear, ask: "I think compaction just ran. What were we working on?"

**Do not** pretend you know what was happening if context is unclear.
`.trim();

const plugin = {
  id: "compaction-guard",
  name: "Compaction Guard",
  description: "Preserves task context across memory compaction",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as CompactionGuardConfig;
    const contextPath = resolveContextPath(config);
    const minMessages = config.minMessagesForSnapshot ?? 10;
    const injectRecovery = config.recoveryPrompt !== false;

    api.logger.info(`Compaction guard enabled (contextPath: ${contextPath})`);

    // Track sessions that need recovery
    const needsRecovery = new Set<string>();

    // Before compaction: save current task context
    api.on("before_compaction", async (event) => {
      const messageCount = event.messageCount ?? 0;

      if (messageCount < minMessages) {
        api.logger.debug?.(
          `[compaction-guard] Skipping snapshot (${messageCount} < ${minMessages} messages)`,
        );
        return;
      }

      state.compactionCount++;
      state.compactionJustHappened = true;
      state.lastCompactionTime = Date.now();

      api.logger.info(
        `[compaction-guard] Compaction #${state.compactionCount} starting (${messageCount} messages)`,
      );

      // Extract and save context from messages if available
      const messages = event.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        const context = await extractTaskContext(messages);
        if (context) {
          try {
            await saveContext(contextPath, context, state.compactionCount);
            state.savedContext = context;
            api.logger.info(`[compaction-guard] Saved task context to ${contextPath}`);
          } catch (err) {
            api.logger.warn(`[compaction-guard] Failed to save context: ${String(err)}`);
          }
        }
      }
    });

    // After compaction: mark recovery needed
    api.on("after_compaction", async (event) => {
      const sessionKey = (event as { sessionKey?: string }).sessionKey ?? "default";

      api.logger.info(
        `[compaction-guard] Compaction complete, marking recovery for session: ${sessionKey}`,
      );
      needsRecovery.add(sessionKey);
    });

    // Before agent start: inject recovery if needed
    api.on("before_agent_start", async (event) => {
      const sessionKey = event.sessionKey ?? "default";

      // Check if this session needs recovery
      if (!needsRecovery.has(sessionKey)) {
        // Also check time-based (in case of restart)
        const timeSinceCompaction = Date.now() - state.lastCompactionTime;
        if (timeSinceCompaction > 60000 || !state.compactionJustHappened) {
          return undefined;
        }
      }

      // Clear the flag
      needsRecovery.delete(sessionKey);
      state.compactionJustHappened = false;

      if (!injectRecovery) {
        return undefined;
      }

      api.logger.info(`[compaction-guard] Injecting recovery context for session: ${sessionKey}`);

      // Load saved context if available
      let recoveryContent = RECOVERY_PROMPT;
      const savedContext = await loadContext(contextPath);
      if (savedContext) {
        recoveryContent += `\n\n---\n\n**Saved Context:**\n\n${savedContext}`;
      }

      return {
        prependContext: recoveryContent,
      };
    });
  },
};

export default plugin;
