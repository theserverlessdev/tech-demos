/** The only paths an agent run is allowed to rewrite. */
export const EDITABLE_PATHS = ["README.md", "NOTES.md", "src/task.ts"] as const;
export type EditablePath = (typeof EDITABLE_PATHS)[number];

export const AGENT_AUTHOR = {
  name: "Task Agent",
  email: "agent@repo-per-agent.invalid",
};

export function seedFiles(title: string): Record<EditablePath, string> {
  return {
    "README.md": `# ${title}\n\nThis repository belongs to one agent task. The agent may edit README.md, NOTES.md, and src/task.ts.\n`,
    "NOTES.md": "# Notes\n\nNothing here yet.\n",
    "src/task.ts": 'export function hello(name: string): string {\n  return `Hello, ${name}`;\n}\n',
  };
}

export function isEditablePath(path: string): path is EditablePath {
  return (EDITABLE_PATHS as readonly string[]).includes(path);
}
