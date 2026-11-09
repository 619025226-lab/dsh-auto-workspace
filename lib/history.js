/**
 * dsh-auto-workspace — pure helpers for reading and copying finished
 * conversations.
 *
 * A Workspace is a directory and a Session's directory is fixed at creation,
 * so "moving" an existing conversation means creating a second Session in the
 * target directory whose prefix is the source's log. These helpers read the
 * log the Host already has: the folded title, the first human message, and the
 * seed shape the Session constructor expects (the source events plus the
 * `session/end-seed` marker `buildForkSeed` produces).
 *
 * Nothing here talks to a service.
 */

/** The last stored event, if any. */
export function lastEvent(events) {
  return Array.isArray(events) && events.length > 0 ? events[events.length - 1] : undefined;
}

/**
 * A conversation can be copied only when its log is balanced: the last turn
 * ended. An interrupted or running tail needs synthetic closers and possibly
 * recovered tool results, which this plugin deliberately does not fabricate.
 *
 * A seeded Session (a copy or fork) ends with `session/end-seed`; the marker
 * itself is child-owned setup, and its inherited prefix is always closed by
 * construction, so a trailing marker counts as balanced.
 */
export function isBalanced(events) {
  const last = lastEvent(events);
  return last?.type === 'turn/end' || last?.type === 'session/end-seed';
}

/** The last user-set or automatic title recorded in the log. */
export function titleOfEvents(events) {
  let title;
  for (const event of events ?? []) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title;
  }
  return title;
}

/** Text of the first human-authored user message. */
export function firstUserText(events) {
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    const text = (Array.isArray(event.data.content) ? event.data.content : [])
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return '';
}

/** The recorded agent preset, when the conversation was started under one. */
export function presetOfEvents(events) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'agent-preset/selected') {
      const preset = event.data?.agentPreset;
      return typeof preset === 'string' && preset.length > 0 ? preset : undefined;
    }
  }
  return undefined;
}

/**
 * Build the seed for a copy of one balanced conversation.
 *
 * The seed is the complete source log (seqs and times preserved) followed by
 * the `session/end-seed` marker, exactly like `buildForkSeed` for a closed
 * tail. `inheritedEventCount` counts only the copied prefix, so the marker is
 * child-owned.
 *
 * @param {Array<object>} events - contiguous source log from seq 0.
 * @returns {{seed: Array<object>, inheritedEventCount: number, boundary: number}}
 */
export function buildCopySeed(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('cannot copy an empty session log');
  if (!isBalanced(events)) throw new Error('cannot copy a session whose last turn did not end');
  const boundary = events.length - 1;
  const seed = [
    ...events,
    {
      type: 'session/end-seed',
      seq: boundary + 1,
      time: events[boundary].time,
      data: { inherited: true },
    },
  ];
  return { seed, inheritedEventCount: boundary + 1, boundary };
}


/**
 * A stable identity for "the same conversation": its title plus its first
 * human message, whitespace-normalized. Copies preserve both, so a restored
 * original matches the copy already sitting in the target Workspace.
 */
export function conversationSignature(title, text) {
  const normalizedTitle = String(title ?? '').trim();
  const normalizedText = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (normalizedTitle.length === 0 && normalizedText.length === 0) return undefined;
  return `${normalizedTitle}\u0000${normalizedText}`;
}
