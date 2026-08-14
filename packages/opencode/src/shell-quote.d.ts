declare module "shell-quote" {
  export function parse(command: string, env?: (name: string) => string, options?: { escape?: string }): any[]
}
