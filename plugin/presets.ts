export interface PresetAgent {
  id: string
  name: string
  description: string
  system: string
}

export interface PresetSkill {
  id: string
  name: string
  description: string
  content: string
}

export interface PresetCommand {
  name: string
  description: string
  agent: string
  prompt: string
}

export const PRESET_AGENTS: readonly PresetAgent[] = [
  {
    id: "scout",
    name: "Scout",
    description:
      "Literature and evidence scout. Finds papers, extracts claims, and builds citation-backed evidence tables without inventing sources.",
    system: `You are Scout, a literature and evidence specialist for research tasks.

Rules:
- Search broadly, then narrow. Prefer primary papers, official benchmarks, and dataset documentation.
- Extract the claim, method, dataset, split, metric, baseline, seed count, and limitation for each source.
- Every factual statement needs a DOI, arXiv id, URL, or local file path. If a source is unavailable, write "insufficient evidence".
- Distinguish peer-reviewed evidence, preprints, blog posts, and vendor claims.
- Report contradictory evidence and gaps explicitly. Do not synthesize a consensus that the sources do not support.
- Return an evidence table plus a short "what is still unknown" list.`,
  },
  {
    id: "experimenter",
    name: "Experimenter",
    description:
      "Experiment designer and runner. Turns a hypothesis into a preregistered, seed-controlled experiment and uses the experiment/job tools to run it.",
    system: `You are Experimenter, a careful empirical researcher.

Before running anything, write a compact preregistration:
hypothesis, independent/dependent variables, controls, baselines, datasets and splits, metrics, seed count, stopping rule, analysis plan, and compute budget.
Use exp_record for every run and job_start for long-running commands. Record seed, config, data version, git SHA, and artifact paths.
Never report a number that was not produced by a tool in this session. If a run failed or is incomplete, say so.
Prefer small pilots before expensive sweeps. Keep a clear distinction between exploratory and confirmatory results.`,
  },
  {
    id: "analyst",
    name: "Analyst",
    description:
      "Statistical and causal analyst. Checks uncertainty, seed variance, multiple comparisons, baselines, and whether conclusions are supported by the recorded evidence.",
    system: `You are Analyst, a statistics and causal-inference reviewer.

Check:
- sample size, seed count, variance, confidence intervals, and effect size
- whether the metric and baseline are comparable
- multiple comparisons and selective reporting
- train/validation/test leakage and dataset shift
- correlation versus causation, and confounders
Use exp_compare, exp_best, and verify to recompute claims. Do not accept a single-seed improvement as evidence.
Return a verdict, the strongest supporting evidence, the strongest threat, and the smallest additional experiment that would resolve it.`,
  },
  {
    id: "critic",
    name: "Critic",
    description:
      "Red-team reviewer. Audits claims, baselines, citations, statistics, and reproducibility, and calls verify before accepting a final answer.",
    system: `You are Critic, an adversarial research reviewer.

Your job is to find what would make the claim false or unverifiable:
- missing or weak baselines, unfair tuning, and cherry-picked metrics
- unsupported numbers, citations that do not say what is claimed, and broken paths
- seed variance, confidence intervals, and multiple-comparison problems
- hidden assumptions, leakage, and non-reproducible steps
Call verify with the exact final answer and structured claims before accepting it. If evidence is missing, require "insufficient evidence" rather than a confident rewrite.
Return: decision (accept/revise/reject), blocking issues, non-blocking issues, and the minimum evidence needed.`,
  },
  {
    id: "writer",
    name: "Writer",
    description:
      "Research writer. Turns verified evidence and experiment records into clear papers, reports, tables, and rebuttals without overclaiming.",
    system: `You are Writer, a precise research writer.

Use only evidence that is present in the session or recorded experiments. Keep a claim-evidence map for every substantive sentence.
Structure: problem, gap, approach, experimental setup, results, limitations, reproducibility, and conclusion.
Prefer short paragraphs, exact numbers with units, and booktabs-style tables. Do not hide negative results or uncertainty.
When a claim is not verified, mark it "insufficient evidence" or remove it. Do not invent citations, baselines, or ablation results.`,
  },
]

export const PRESET_SKILLS: readonly PresetSkill[] = [
  {
    id: "deepseek-paper-reading",
    name: "Paper reading",
    description:
      "Use when reading a paper or literature source and extracting its claim, method, data, baselines, metrics, ablations, limitations, and reproducibility details into an evidence table.",
    content: `# Paper reading

1. Identify the research question and the paper's actual claim.
2. Extract: method, datasets/splits, baselines, metrics, seeds, compute, and code/data availability.
3. Separate the paper's reported result from your interpretation.
4. Record at least one limitation and one threat to validity.
5. Note whether the result is comparable to the current project's baseline.
6. Produce an evidence row: claim | method | data | metric | result | limitation | DOI/arXiv/URL.
7. If a field is missing, write "insufficient evidence"; never fill it from memory.`,
  },
  {
    id: "deepseek-experiment-design",
    name: "Experiment design",
    description:
      "Use when turning a hypothesis into a preregistered experiment, choosing baselines and metrics, or planning an ablation and seed budget.",
    content: `# Experiment design

Write a preregistration before running:
- hypothesis and falsification condition
- independent/dependent variables and controls
- baselines, datasets, splits, and preprocessing
- primary metric plus secondary metrics
- seed count and aggregation rule
- stopping rule and compute budget
- confirmatory vs exploratory analyses

Prefer a small pilot. Record every run with exp_record and every long command with job_start.
A result is not confirmatory until the preregistered seeds and analysis are complete.`,
  },
  {
    id: "deepseek-statistics",
    name: "Statistical review",
    description:
      "Use when checking significance, confidence intervals, seed variance, effect sizes, multiple comparisons, or whether a quantitative research claim is statistically supportable.",
    content: `# Statistical review

Check:
- n, seed count, missing runs, and aggregation method
- sample standard deviation and confidence interval; report the interval, not only p-values
- effect size and practical significance
- paired vs unpaired comparisons
- multiple comparisons and selective reporting
- baseline fairness and tuning budget
- leakage, distribution shift, and independence assumptions

Do not turn correlation into causation. State the smallest additional experiment that would resolve the uncertainty.`,
  },
  {
    id: "deepseek-latex",
    name: "LaTeX tables",
    description:
      "Use when formatting research results as LaTeX tables, especially booktabs tables for papers, with consistent significant digits, units, captions, and reproducible source data.",
    content: `# LaTeX tables

- Use booktabs: toprule, midrule, bottomrule; no vertical rules.
- Keep one metric per column and one configuration per row.
- Report units and seed aggregation in the caption or column header.
- Use consistent significant digits; do not add precision that the data does not support.
- Bold the best result only when the comparison is fair; mark missing runs explicitly.
- Put the source artifact or experiment id in a comment or caption.
- Keep the .tex source generated from a script or table data, not hand-edited numbers.`,
  },
  {
    id: "deepseek-rebuttal",
    name: "Rebuttal",
    description:
      "Use when drafting a response to reviewer criticism, planning a rebuttal experiment, or writing a concise evidence-based author response.",
    content: `# Rebuttal

For each reviewer point:
1. Quote or paraphrase the concern precisely.
2. State whether you agree, partially agree, or disagree.
3. Point to existing evidence (section, table, experiment id).
4. If new evidence is needed, describe the smallest valid experiment and its cost.
5. Concede real limitations; do not overclaim.

Keep responses short and specific. Never invent a result or cite a paper you have not checked. Put the strongest evidence first and separate blocking concerns from minor clarifications.`,
  },
]

const COMMAND_SUFFIX = `

Use the research tools available in this session. If the user input is empty, ask for the missing task details before proceeding.
User input:`

export const PRESET_COMMANDS: readonly PresetCommand[] = [
  {
    name: "lit",
    description: "Run a citation-backed literature review and evidence table.",
    agent: "scout",
    prompt: `Run a literature-review pass as Scout.

Deliver: research question and scope; search strategy and queries; an evidence table with claim, method, dataset, metric, result, limitation, and DOI/arXiv/URL; supporting and contradicting evidence; gaps; and the next experiment. Do not invent citations.${COMMAND_SUFFIX}`,
  },
  {
    name: "prereg",
    description: "Turn an idea into a preregistered experiment plan.",
    agent: "experimenter",
    prompt: `Turn the request into a preregistration as Experimenter.

Include: hypothesis and falsification condition, variables and controls, baselines, datasets/splits, metrics, seed count, stopping rule, analysis plan, compute budget, and threats to validity. Do not run the experiment until the plan is explicit.${COMMAND_SUFFIX}`,
  },
  {
    name: "ablate",
    description: "Design a prioritized ablation matrix with controls and budget.",
    agent: "experimenter",
    prompt: `Design an ablation study as Experimenter.

List each component, the control/removal, the expected effect, priority, seed count, metric, stopping rule, and compute cost. Identify which ablations are confirmatory and which are exploratory. Include a small pilot before the full matrix.${COMMAND_SUFFIX}`,
  },
  {
    name: "verify",
    description: "Audit claims and call the verify tool before delivery.",
    agent: "critic",
    prompt: `Audit the current answer as Critic.

Call verify with the exact final text and structured claims. Recompute numbers from recorded data, check citations and paths, check experiment seeds/baselines, and syntax-check code. Return pass/fail, blocking issues, and the minimum fixes. Never accept an unsupported number or citation.${COMMAND_SUFFIX}`,
  },
  {
    name: "paper",
    description: "Draft a paper/report section from verified evidence.",
    agent: "writer",
    prompt: `Draft the requested paper or report section as Writer.

Build a claim-evidence map first, then write problem, gap, approach, setup, results, limitations, reproducibility, and conclusion. Use exact numbers and citations from the session only. Mark unverified claims as "insufficient evidence" or remove them.${COMMAND_SUFFIX}`,
  },
]

interface AgentEditorLike {
  get(id: string): unknown
  update(id: string, update: (agent: any) => void): void
}

interface SkillEditorLike {
  get(id: string): unknown
  add(skill: {
    id: string
    name: string
    description: string
    autoinvoke: boolean
    path: string
    content: string
  }): void
}

interface CommandEditorLike {
  add(command: {
    name: string
    description: string
    execute: (input: any) => Promise<void>
  }): void
}

export interface AgentPresetDomain {
  transform(callback: (editor: AgentEditorLike) => void): Promise<unknown>
}

export interface SkillPresetDomain {
  transform(callback: (editor: SkillEditorLike) => void): Promise<unknown>
}

export interface CommandPresetDomain {
  transform(callback: (editor: CommandEditorLike) => void): Promise<unknown>
}

export interface CommandSession {
  prompt(input: {
    sessionID: string
    text: string
    files?: unknown
    agents?: unknown
    skills?: unknown
    metadata?: Record<string, unknown>
    delivery?: "steer" | "queue"
  }): Promise<unknown>
  switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>
}

export interface CommandDependencies {
  session: CommandSession
  agent?: {
    get(input: { agentID: string }): Promise<unknown>
  }
  warn?: (message: string, error?: unknown) => void
}

export interface CommandInvocationLike {
  sessionID: string
  prompt?: {
    text?: string
    files?: unknown
    agents?: unknown
    skills?: unknown
  }
  delivery?: "steer" | "queue"
}

export function renderCommand(command: PresetCommand, userInput: string | undefined): string {
  const input = (userInput ?? "").trim()
  return `${command.prompt}\n${input.length > 0 ? input : "(none provided; ask for the missing details)"}`
}

async function agentExists(deps: CommandDependencies, id: string): Promise<boolean> {
  if (!deps.agent?.get) return false
  try {
    const response = await deps.agent.get({ agentID: id })
    const info =
      response && typeof response === "object" && "data" in response
        ? (response as { data?: unknown }).data
        : response
    return !!info && typeof info === "object"
  } catch {
    return false
  }
}

export async function registerAgentPresets(domain: AgentPresetDomain): Promise<void> {
  await domain.transform((editor) => {
    for (const preset of PRESET_AGENTS) {
      // Never overwrite a user-defined agent with the same id.
      if (editor.get(preset.id) !== undefined) continue
      editor.update(preset.id, (agent) => {
        agent.name = preset.name
        agent.description = preset.description
        agent.mode = "all"
        agent.hidden = false
        agent.system = preset.system
      })
    }
  })
}

export async function registerResearchSkills(domain: SkillPresetDomain): Promise<void> {
  await domain.transform((editor) => {
    for (const skill of PRESET_SKILLS) {
      if (editor.get(skill.id) !== undefined) continue
      editor.add({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        autoinvoke: true,
        path: `/builtin/deepseek-research/${skill.id}.md`,
        content: skill.content,
      })
    }
  })
}

export async function registerResearchCommands(
  domain: CommandPresetDomain,
  deps: CommandDependencies,
): Promise<void> {
  await domain.transform((editor) => {
    for (const command of PRESET_COMMANDS) {
      editor.add({
        name: command.name,
        description: command.description,
        execute: async (input: CommandInvocationLike) => {
          const text = renderCommand(command, input.prompt?.text)
          if (command.agent && deps.session.switchAgent && (await agentExists(deps, command.agent))) {
            try {
              await deps.session.switchAgent({ sessionID: input.sessionID, agent: command.agent })
            } catch (error) {
              ;(deps.warn ?? ((message, cause) => console.warn(message, cause)))(
                `[deepseek-research] could not switch to agent ${command.agent}`,
                error,
              )
            }
          }
          await deps.session.prompt({
            sessionID: input.sessionID,
            text,
            ...(input.prompt?.files === undefined ? {} : { files: input.prompt.files }),
            ...(input.prompt?.agents === undefined ? {} : { agents: input.prompt.agents }),
            ...(input.prompt?.skills === undefined ? {} : { skills: input.prompt.skills }),
            metadata: { source: "deepseek-research", command: command.name },
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          })
        },
      })
    }
  })
}

export function presetAgentIds(): string[] {
  return PRESET_AGENTS.map((agent) => agent.id)
}

export function presetSkillIds(): string[] {
  return PRESET_SKILLS.map((skill) => skill.id)
}

export function presetCommandNames(): string[] {
  return PRESET_COMMANDS.map((command) => command.name)
}
