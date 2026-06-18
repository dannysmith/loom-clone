// Visually-hidden pointer for AI agents that fetch the rendered HTML. It
// stays in the DOM and survives HTML→markdown conversion (clip-rect, not
// `display:none`, which some converters strip), telling agents where to find
// the machine-readable site index and the markdown version of this page.
// See agentdocsspec.com — llms-txt-directive-html.
const HIDDEN =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";

export function AgentDirective({ mdUrl }: { mdUrl: string }) {
  return (
    <div class="agent-directive" style={HIDDEN}>
      For AI agents: a machine-readable index of this site is available at{" "}
      <a href="/llms.txt">/llms.txt</a>. A Markdown version of this page is available at{" "}
      <a href={mdUrl}>{mdUrl}</a>.
    </div>
  );
}
