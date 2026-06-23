import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelsDevPlugin } from "@opencode-ai/core/plugin/models-dev"
import { Policy } from "@opencode-ai/core/policy"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const events = EventV2.defaultLayer
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const policy = Policy.layer.pipe(Layer.provide(locationLayer))
const connections = Credential.defaultLayer.pipe(Layer.fresh)
const integrations = Integration.locationLayer.pipe(Layer.provide(events), Layer.provide(connections))
const catalog = Catalog.layer.pipe(
  Layer.provide(Layer.mergeAll(events, locationLayer, policy, connections, integrations)),
)
const layer = Layer.mergeAll(catalog.pipe(Layer.provide(connections)), integrations, connections, events, locationLayer)
const it = testEffect(layer)

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

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

function runModelsDevPlugin() {
  return Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    yield* ModelsDevPlugin.effect(
      host({
        catalog: catalogHost(catalog),
        integration: integrationHost(integrations),
      }),
    )
  })
}

describe("ModelsDevPlugin", () => {
  it.effect("registers key methods for providers with environment variables", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* runModelsDevPlugin()
        const integrations = yield* Integration.Service
        expect(yield* integrations.list()).toEqual([
          new Integration.Info({
            id: Integration.ID.make("acme"),
            name: "Acme",
            methods: [
              { type: "key" },
              {
                type: "env",
                names: ["ACME_API_KEY"],
              },
            ],
            connections: [],
          }),
        ])
      }),
    ),
  )

  it.effect("synthesizes effort reasoning option variants through AI SDK request normalization", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* runModelsDevPlugin()
        const catalog = yield* Catalog.Service
        const model = required(yield* catalog.model.get(ProviderV2.ID.make("zai-coding-plan"), ModelV2.ID.make("glm-5.2")))
        expect(model.variants).toEqual([
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            generation: {},
            options: { reasoningEffort: "high" },
            body: {},
          },
          {
            id: ModelV2.VariantID.make("max"),
            headers: {},
            generation: {},
            options: { reasoningEffort: "max" },
            body: {},
          },
        ])
      }),
    ),
  )

  it.effect("keeps experimental modes higher priority than reasoning options", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* runModelsDevPlugin()
        const catalog = yield* Catalog.Service
        const model = required(
          yield* catalog.model.get(ProviderV2.ID.make("zai-coding-plan"), ModelV2.ID.make("mode-priority")),
        )
        expect(model.variants).toEqual([
          {
            id: ModelV2.VariantID.make("custom"),
            headers: { "x-model-mode": "custom" },
            generation: {},
            options: { reasoningEffort: "high" },
            body: {},
          },
        ])
      }),
    ),
  )

  it.effect("does not synthesize reasoning variants when experimental modes are present but empty", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* runModelsDevPlugin()
        const catalog = yield* Catalog.Service
        const model = required(
          yield* catalog.model.get(ProviderV2.ID.make("zai-coding-plan"), ModelV2.ID.make("empty-modes")),
        )
        expect(model.variants).toEqual([])
      }),
    ),
  )

  it.effect("does not synthesize reasoning variants for unsupported provider packages", () =>
    withModelsDevFixture(
      Effect.gen(function* () {
        yield* runModelsDevPlugin()
        const catalog = yield* Catalog.Service
        const model = required(yield* catalog.model.get(ProviderV2.ID.make("local"), ModelV2.ID.make("native-effort")))
        expect(model.variants).toEqual([])
      }),
    ),
  )
})
