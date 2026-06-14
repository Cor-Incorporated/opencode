import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventLocation(instance: InstanceContext, workspaceID: WorkspaceV2.ID | undefined, event?: EventV2.Payload) {
  const selectedWorkspaceID = event?.location?.workspaceID ?? workspaceID
  return {
    directory: event?.location?.directory ?? instance.directory,
    ...(selectedWorkspaceID ? { workspaceID: selectedWorkspaceID } : {}),
    project: { id: instance.project.id, directory: instance.worktree },
  }
}

function streamEvent(instance: InstanceContext, workspaceID: WorkspaceV2.ID | undefined, event: EventV2.Payload) {
  return {
    id: event.id,
    type: event.type,
    location: eventLocation(instance, workspaceID, event),
    data: event.data,
    properties: event.data,
  }
}

function serverEvent(
  instance: InstanceContext,
  workspaceID: WorkspaceV2.ID | undefined,
  type: string,
  data: unknown = {},
  id: string = eventID(),
) {
  return {
    id,
    type,
    location: eventLocation(instance, workspaceID),
    data,
    properties: data,
  }
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.unbounded<EventV2.Payload>()
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => Queue.offerUnsafe(queue, event)))
    yield* Effect.addFinalizer(() => unsubscribe)
    const stream = Stream.fromQueue(queue).pipe(
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
      ),
      Stream.map((event) => streamEvent(instance, workspaceID, event)),
    )
    const disposed = Stream.callback<ReturnType<typeof serverEvent>>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(
          queue,
          serverEvent(
            instance,
            workspaceID,
            "server.instance.disposed",
            event.payload.properties ?? {},
            event.payload.id,
          ),
        )
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => serverEvent(instance, workspaceID, "server.heartbeat")),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make(serverEvent(instance, workspaceID, "server.connected")).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
