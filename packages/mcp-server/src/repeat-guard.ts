// A weaker model can resend the same test message over and over, expecting a different answer (seen in a test run:
// 33 identical calls). Same request and same answer in a row: a hint from the third, a refusal from the tenth, until
// the request changes or some minutes pass.

export const REPEAT_HINT_FROM = 3;
export const REPEAT_STOP_FROM = 10;
const WINDOW_MS = 10 * 60_000;

export class RepeatGuard {
  private last: { request: string; answer: string; count: number; at: number } | undefined;

  /** Before sending: a refusal text when this request was answered the same way too often in a row */
  check(request: string, now = Date.now()): string | undefined {
    const l = this.last;
    if (l && l.request === request && now - l.at < WINDOW_MS && l.count >= REPEAT_STOP_FROM) {
      return `not sent: this exact request was sent ${l.count} times in a row and got the same answer each time; sending it again ` +
        'will not change the result. Change the request (path, headers, body) so the iFlow takes another route, read what ' +
        'happened with cpi_message, or ask the user how to go on';
    }
    return undefined;
  }

  /** After the answer: a hint when the same request got the same answer several times in a row */
  record(request: string, answer: string, now = Date.now()): string | undefined {
    const l = this.last;
    const same = l && l.request === request && l.answer === answer && now - l.at < WINDOW_MS;
    this.last = { request, answer, count: same ? l!.count + 1 : 1, at: now };
    if (this.last.count < REPEAT_HINT_FROM) return undefined;
    return `the same request got the same answer ${this.last.count} times in a row: resending will not change it. To reach another ` +
      'route, send the headers or body its condition needs (iflow_describe shows the router conditions); a changed configuration ' +
      'takes effect only after a new deploy (cpi_runtime_status shows when it runs); cpi_message shows what happened';
  }
}
