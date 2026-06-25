export type Live2DCommand =
  | { type: "ping" }
  | { type: "wave" }
  | { type: "speak"; clipId: string }
  | { type: "motion"; motionId: string }
  | { type: "raw"; value: string };

export function serializeCommand(command: Live2DCommand): string {
  switch (command.type) {
    case "ping":
      return "ping";
    case "wave":
      return "wave";
    case "speak":
      return `speak:${command.clipId}`;
    case "motion":
      return `motion:${command.motionId}`;
    case "raw":
      return command.value;
  }
}

export function parseCommand(value: string): Live2DCommand {
  if (value === "ping") {
    return { type: "ping" };
  }
  if (value === "wave") {
    return { type: "wave" };
  }
  if (value.startsWith("speak:")) {
    return { type: "speak", clipId: value.slice("speak:".length) };
  }
  if (value.startsWith("motion:")) {
    return { type: "motion", motionId: value.slice("motion:".length) };
  }
  return { type: "raw", value };
}
