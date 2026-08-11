const DEFAULT_MAX_OUTPUT_TOKENS = 6_000
const MAX_MODEL_OUTPUT_LENGTH = 256 * 1024

export type TranscriptMode = "text" | "escape" | "escape-intermediate" | "csi" | "osc" | "string"

export type TranscriptState = {
  transcriptMode: TranscriptMode
}

export type ModelOutput = {
  head: string
  headBytes: number
  tail: string[]
  tailStart: number
  tailBytes: number
  omittedBytes: number
  omissionUnknown: boolean
}

export function createModelOutput(): ModelOutput {
  return {
    head: "",
    headBytes: 0,
    tail: [],
    tailStart: 0,
    tailBytes: 0,
    omittedBytes: 0,
    omissionUnknown: false,
  }
}

export function sanitizeTranscript(state: TranscriptState, input: string) {
  if (state.transcriptMode === "text" && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(input)) return input
  let output = ""
  for (const char of input) {
    const code = char.charCodeAt(0)
    const mode = state.transcriptMode

    if (code === 0x1b) {
      state.transcriptMode = "escape"
      continue
    }
    if (code === 0x18 || code === 0x1a) {
      state.transcriptMode = "text"
      continue
    }
    if (code === 0x9b) {
      state.transcriptMode = "csi"
      continue
    }
    if (code === 0x9d) {
      state.transcriptMode = "osc"
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      state.transcriptMode = "string"
      continue
    }
    if (code === 0x9c || (mode === "osc" && code === 0x07)) {
      state.transcriptMode = "text"
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if ((code === 0x09 || code === 0x0a || code === 0x0d) && mode !== "osc" && mode !== "string") {
        output += char
      }
      if (code >= 0x80) state.transcriptMode = "text"
      continue
    }

    if (mode === "text") {
      output += char
      continue
    }

    if (mode === "escape") {
      if (char === "[") state.transcriptMode = "csi"
      else if (char === "]") state.transcriptMode = "osc"
      else if (char === "P" || char === "X" || char === "^" || char === "_") state.transcriptMode = "string"
      else if (code >= 0x20 && code <= 0x2f) state.transcriptMode = "escape-intermediate"
      else if (code !== 0x1b) state.transcriptMode = "text"
      continue
    }

    if (mode === "escape-intermediate") {
      if (code >= 0x30 && code <= 0x7e) state.transcriptMode = "text"
      else if (code < 0x20 || code > 0x7e) state.transcriptMode = "text"
      continue
    }

    if (mode === "csi") {
      if (code >= 0x40 && code <= 0x7e) state.transcriptMode = "text"
      else if (code < 0x20 || code > 0x7e) state.transcriptMode = "text"
      continue
    }
  }
  return output
}

export function readModelOutput(output: ModelOutput, running: boolean, maxOutputTokens: number | undefined) {
  return running ? readRunningModelOutput(output, maxOutputTokens) : readCompletedModelOutput(output, maxOutputTokens)
}

export function appendModelOutput(output: ModelOutput, text: string) {
  if (!text) return
  const textBytes = Buffer.byteLength(text)
  if (!output.omittedBytes && !output.omissionUnknown) {
    output.head += text
    output.headBytes += textBytes
    if (output.headBytes <= MAX_MODEL_OUTPUT_LENGTH) return

    const totalBytes = output.headBytes
    const head = takeUtf8Head(output.head, Math.floor(MAX_MODEL_OUTPUT_LENGTH / 2))
    const tail = takeUtf8Tail(output.head.slice(head.text.length), MAX_MODEL_OUTPUT_LENGTH - head.bytes)
    output.head = head.text
    output.headBytes = head.bytes
    output.tail = [tail.text]
    output.tailStart = 0
    output.tailBytes = tail.bytes
    output.omittedBytes = totalBytes - head.bytes - tail.bytes
    return
  }

  output.tail.push(text)
  output.tailBytes += textBytes
  const limit = MAX_MODEL_OUTPUT_LENGTH - output.headBytes
  while (output.tailBytes > limit) {
    const first = output.tail[output.tailStart]
    if (first === undefined) break
    const firstBytes = Buffer.byteLength(first)
    const excess = output.tailBytes - limit
    if (firstBytes <= excess) {
      output.tailStart++
      output.tailBytes -= firstBytes
      output.omittedBytes += firstBytes
      continue
    }
    const tail = takeUtf8Tail(first, firstBytes - excess)
    output.tail[output.tailStart] = tail.text
    output.tailBytes -= tail.omittedBytes
    output.omittedBytes += tail.omittedBytes
  }
  if (output.tailStart > 1_024 && output.tailStart * 2 > output.tail.length) {
    output.tail = output.tail.slice(output.tailStart)
    output.tailStart = 0
  }
}

function readRunningModelOutput(output: ModelOutput, maxOutputTokens: number | undefined) {
  const limit = Math.max(1, maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * 4
  if (output.head) {
    const text = takeUtf16Head(output.head, limit)
    output.head = output.head.slice(text.length)
    output.headBytes -= Buffer.byteLength(text)
    const truncated = hasModelOutput(output)
    return {
      text: truncated ? text + "\n\n...output truncated..." : text,
      truncated,
    }
  }

  if (output.omittedBytes || output.omissionUnknown) {
    const marker = output.omissionUnknown ? unknownOmissionMarker() : omissionMarker(output.omittedBytes)
    output.omittedBytes = 0
    output.omissionUnknown = false
    output.head = tailText(output)
    output.headBytes = output.tailBytes
    output.tail = []
    output.tailStart = 0
    output.tailBytes = 0
    const text = takeUtf16Head(output.head, limit)
    output.head = output.head.slice(text.length)
    output.headBytes -= Buffer.byteLength(text)
    return {
      text: text ? `${marker}\n\n${text}` : marker,
      truncated: true,
    }
  }

  return { text: "", truncated: false }
}

function readCompletedModelOutput(output: ModelOutput, maxOutputTokens: number | undefined) {
  const limit = Math.max(1, maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * 4
  const tail = tailText(output)
  const retained = output.head + tail
  const retainedBytes = output.headBytes + output.tailBytes
  const hadOmission = output.omittedBytes > 0 || output.omissionUnknown
  if (!hadOmission && retained.length <= limit) {
    clearModelOutput(output)
    return { text: retained, truncated: false }
  }

  if (!hadOmission) {
    const head = takeUtf16Head(retained, Math.floor(limit / 2))
    const tail = takeUtf16Tail(retained, limit - head.length)
    const omittedBytes = retainedBytes - Buffer.byteLength(head) - Buffer.byteLength(tail)
    clearModelOutput(output)
    return {
      text: `${head}\n\n${omissionMarker(omittedBytes)}\n\n${tail}`,
      truncated: true,
    }
  }

  const priorMarker = output.omissionUnknown ? unknownOmissionMarker() : omissionMarker(output.omittedBytes)
  if (output.head && tail && retained.length <= limit) {
    const text = `${output.head}\n\n${priorMarker}\n\n${tail}`
    clearModelOutput(output)
    return { text, truncated: true }
  }

  if (output.head && tail) {
    const head = takeUtf16Head(output.head, Math.floor(limit / 2))
    const resultTail = takeUtf16Tail(tail, limit - head.length)
    const omittedBytes = output.omittedBytes + retainedBytes - Buffer.byteLength(head) - Buffer.byteLength(resultTail)
    const marker = output.omissionUnknown ? unknownOmissionMarker() : omissionMarker(omittedBytes)
    clearModelOutput(output)
    return {
      text: `${head}\n\n${marker}\n\n${resultTail}`,
      truncated: true,
    }
  }

  if (output.head) {
    const head = takeUtf16Head(output.head, limit)
    const omittedBytes = output.omittedBytes + output.headBytes - Buffer.byteLength(head)
    const marker = output.omissionUnknown ? unknownOmissionMarker() : omissionMarker(omittedBytes)
    clearModelOutput(output)
    return {
      text: `${head}\n\n${marker}`,
      truncated: true,
    }
  }

  if (tail.length <= limit) {
    const text = tail ? `${priorMarker}\n\n${tail}` : priorMarker
    clearModelOutput(output)
    return { text, truncated: true }
  }

  const head = takeUtf16Head(tail, Math.floor(limit / 2))
  const resultTail = takeUtf16Tail(tail, limit - head.length)
  const omittedBytes = output.tailBytes - Buffer.byteLength(head) - Buffer.byteLength(resultTail)
  clearModelOutput(output)
  return {
    text: `${priorMarker}\n\n${head}\n\n${omissionMarker(omittedBytes)}\n\n${resultTail}`,
    truncated: true,
  }
}

function hasModelOutput(output: ModelOutput) {
  return Boolean(output.head || output.tailBytes || output.omittedBytes || output.omissionUnknown)
}

function clearModelOutput(output: ModelOutput) {
  output.head = ""
  output.headBytes = 0
  output.tail = []
  output.tailStart = 0
  output.tailBytes = 0
  output.omittedBytes = 0
  output.omissionUnknown = false
}

function tailText(output: ModelOutput) {
  return output.tail.slice(output.tailStart).join("")
}

function takeUtf16Head(input: string, limit: number) {
  let end = Math.min(input.length, limit)
  if (end > 0 && end < input.length && isHighSurrogate(input.charCodeAt(end - 1))) end--
  return input.slice(0, end)
}

function takeUtf16Tail(input: string, limit: number) {
  let start = Math.max(0, input.length - limit)
  if (start > 0 && start < input.length && isLowSurrogate(input.charCodeAt(start))) start++
  return input.slice(start)
}

function takeUtf8Tail(input: string, limit: number) {
  const bytes = Buffer.from(input)
  if (bytes.length <= limit) return { text: input, bytes: bytes.length, omittedBytes: 0 }
  let start = bytes.length - limit
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return {
    text: bytes.subarray(start).toString("utf8"),
    bytes: bytes.length - start,
    omittedBytes: start,
  }
}

function takeUtf8Head(input: string, limit: number) {
  const bytes = Buffer.from(input)
  if (bytes.length <= limit) return { text: input, bytes: bytes.length }
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    bytes: end,
  }
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff
}

function omissionMarker(bytes: number) {
  return `... ${bytes} bytes omitted ...`
}

function unknownOmissionMarker() {
  return "... output omitted ..."
}
