import type { Interface as ActorInterface } from "./spawn"

export const spawnRef: { current: ActorInterface | undefined } = { current: undefined }
