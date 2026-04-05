export namespace Memory {
  export const TYPES = ["error-solution", "build-command", "preference", "decision", "config-pattern", "general"] as const
  export type Type = (typeof TYPES)[number]

  export type Info = {
    id: string
    projectPath: string
    topic: string
    type: Type
    content: string
    sessionID?: string
    accessCount: number
    timeCreated: number
    timeUpdated: number
  }

  export type Create = {
    projectPath: string
    topic: string
    type: Type
    content: string
    sessionID?: string
  }

  export type Update = {
    id: string
    topic?: string
    type?: Type
    content?: string
  }

  export type Frontmatter = {
    topic: string
    type: Type
  }

  export type FileEntry = {
    filename: string
    frontmatter: Frontmatter
    content: string
  }
}
