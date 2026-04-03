import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  const resolvedDirectory = process.env.OPENCODE_ORIGINAL_CWD || directory
  return Instance.provide({
    directory: resolvedDirectory,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        const result = await cb()
        return result
      } finally {
        await Instance.dispose()
      }
    },
  })
}
