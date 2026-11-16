export const engineeringCategories = [
  { id: "models", name: "Models - Copilot availability" },
  { id: "tools", name: "Developer tools" },
  { id: "frameworks", name: "Agent frameworks" },
] as const;

export const engineeringSources = [
  { repo: "microsoft/vscode", name: "VS Code", category: "tools" },
  { repo: "anthropics/claude-code", name: "Claude Code", category: "tools" },
  { repo: "openai/openai-agents-python", name: "OpenAI Agents SDK (Python)", category: "frameworks" },
  { repo: "openai/openai-agents-js", name: "OpenAI Agents SDK (TypeScript)", category: "frameworks" },
  { repo: "langchain-ai/langgraph", name: "LangGraph", category: "frameworks" },
  { repo: "crewAIInc/crewAI", name: "CrewAI", category: "frameworks" },
  { repo: "pydantic/pydantic-ai", name: "PydanticAI", category: "frameworks" },
  { repo: "microsoft/agent-framework", name: "Microsoft Agent Framework", category: "frameworks" },
] as const;

export const copilotChangelog = {
  name: "GitHub Copilot",
  url: "https://github.blog/changelog/label/copilot/feed/",
  channelUrl: "https://github.blog/changelog/label/copilot/",
} as const;
