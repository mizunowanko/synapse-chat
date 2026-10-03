/**
 * Where a skill lives, and who may write there (docs/design/skills-mcp.md).
 *
 * Three tiers, top to bottom: everyone → one agent → one desk of that agent.
 * The lower tier wins when two tiers hold the same name.
 */

/** `agent: ""` is the everyone tier; `desk: ""` means "not a desk". */
export interface SkillScope {
  readonly agent: string;
  readonly desk: string;
}

export const GLOBAL_SCOPE: SkillScope = { agent: "", desk: "" };

export function agentScope(agent: string): SkillScope {
  assertIdent("agent", agent);
  return { agent, desk: "" };
}

export function deskScope(agent: string, desk: string): SkillScope {
  assertIdent("agent", agent);
  assertIdent("desk", desk);
  return { agent, desk };
}

export type ScopeTier = "global" | "agent" | "desk";

export function tierOf(scope: SkillScope): ScopeTier {
  if (scope.agent === "") return "global";
  return scope.desk === "" ? "agent" : "desk";
}

export function describeScope(scope: SkillScope): string {
  switch (tierOf(scope)) {
    case "global":
      return "全員";
    case "agent":
      return `エージェント ${scope.agent}`;
    case "desk":
      return `Desk ${scope.agent}/${scope.desk}`;
  }
}

/**
 * The tiers a viewer sees, lowest (strongest) first. A viewer with no agent
 * sees only the everyone tier.
 */
export function visibleScopes(viewer: SkillScope): SkillScope[] {
  if (viewer.agent === "") return [GLOBAL_SCOPE];
  if (viewer.desk === "") return [viewer, GLOBAL_SCOPE];
  return [viewer, agentScope(viewer.agent), GLOBAL_SCOPE];
}

export function sameScope(a: SkillScope, b: SkillScope): boolean {
  return a.agent === b.agent && a.desk === b.desk;
}

/**
 * The write rule for the MCP tool `put_skill`: a session writes only to its
 * own agent tier or its own desk tier. Nobody writes the everyone tier
 * through MCP — that tier carries scripts every agent runs, so it is changed
 * with the management CLI by someone who means to.
 *
 * Returns a reason when refused, `null` when allowed.
 */
export function mcpWriteRefusal(session: SkillScope, target: SkillScope): string | null {
  if (session.agent === "") {
    return "このセッションにはエージェントが指定されていない（サーバーの起動引数 --agent）。スキルを書き込めない";
  }
  const tier = tierOf(target);
  if (tier === "global") {
    return "「全員」の階層は MCP からは書き込めない。管理用の CLI（synapse-skills import --global）を使う";
  }
  if (target.agent !== session.agent) {
    return `ほかのエージェント（${target.agent}）の階層には書き込めない`;
  }
  if (tier === "desk" && target.desk !== session.desk) {
    return session.desk === ""
      ? "このセッションには Desk が指定されていない（サーバーの起動引数 --desk）"
      : `ほかの Desk（${target.desk}）の階層には書き込めない`;
  }
  return null;
}

const IDENT_RE = /^[^\s/\\][^/\\]*$/;

function assertIdent(kind: string, value: string): void {
  if (!IDENT_RE.test(value) || value.trim() !== value) {
    throw new Error(`invalid ${kind} name: ${JSON.stringify(value)}`);
  }
}

/** Skill names become directory names, so keep them to one safe path segment. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `invalid skill name: ${JSON.stringify(name)} (英数字で始まり、英数字と . _ - だけ、64 文字まで)`,
    );
  }
}
