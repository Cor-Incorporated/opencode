import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelsDevPlugin } from "@opencode-ai/core/plugin/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const it = testEffect(
  Catalog.locationLayer.pipe(Layer.provideMerge(EventV2.defaultLayer), Layer.provideMerge(locationLayer)),
)

function withModelsDevFixture<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        path: Flag.OPENCODE_MODELS_PATH,
        disabled: Flag.OPENCODE_DISABLE_MODELS_FETCH,
      }
      Flag.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
      Flag.OPENCODE_DISABLE_MODELS_FETCH = true
      return previous
    }),
    () => effect.pipe(Effect.provide(ModelsDev.defaultLayer)),
    (previous) =>
      Effect.sync(() => {
        Flag.OPENCODE_MODELS_PATH = previous.path
        Flag.OPENCODE_DISABLE_MODELS_FETCH = previous.disabled
      }),
  )
}

describe("ModelsDevPlugin", () => {
  it.effect("synthesizes effort reasoning option variants", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* ModelsDevPlugin.effect
        const catalog = yield* Catalog.Service
        const model = yield* catalog.model.get(ProviderV2.ID.make("zai-coding-plan"), ModelV2.ID.make("glm-5.2"))
        expect(model.variants).toEqual([
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: { reasoningEffort: "high" },
          },
          {
            id: ModelV2.VariantID.make("max"),
            headers: {},
            body: { reasoningEffort: "max" },
          },
        ])
      }),
    ),
  )

  it.effect("keeps experimental modes higher priority than reasoning options", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* ModelsDevPlugin.effect
        const catalog = yield* Catalog.Service
        const model = yield* catalog.model.get(ProviderV2.ID.make("zai-coding-plan"), ModelV2.ID.make("mode-priority"))
        expect(model.variants).toEqual([
          {
            id: ModelV2.VariantID.make("custom"),
            headers: { "x-model-mode": "custom" },
            body: { reasoningEffort: "high" },
          },
        ])
      }),
    ),
  )
})
