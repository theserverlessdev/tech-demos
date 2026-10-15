export type WidgetAction = "session" | "draft" | "write";

export type TurnstileWidget = {
  action: WidgetAction | null;
  mount(action: WidgetAction): void;
  takeToken(): Promise<string>;
};

export async function tokenForAction(
  widget: TurnstileWidget,
  action: WidgetAction,
  opts: { siteKey: string; testSiteKey: boolean; dummy: string },
): Promise<string | undefined> {
  if (!opts.siteKey) return undefined;
  if (opts.testSiteKey) return opts.dummy;
  if (widget.action !== action) widget.mount(action);
  return widget.takeToken();
}
