import type { ColorInput } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { ColorGenerator } from "opentui-spinner"

export function SpinnerGlyph(props: { frames: string[]; interval: number; color?: ColorInput | ColorGenerator }) {
  const [frameIndex, setFrameIndex] = createSignal(0)
  const frames = createMemo(() => (props.frames.length ? props.frames : [""]))
  const chars = createMemo(() => Array.from(frames()[frameIndex() % frames().length] ?? ""))

  createEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % frames().length)
    }, props.interval)

    onCleanup(() => clearInterval(timer))
  })

  return (
    <box flexDirection="row" flexShrink={0}>
      {chars().map((char, charIndex) => (
        <text
          fg={
            typeof props.color === "function"
              ? props.color(frameIndex(), charIndex, frames().length, chars().length)
              : props.color
          }
        >
          {char}
        </text>
      ))}
    </box>
  )
}
