import {
  AccountSessionControlView,
  type AccountControlState,
} from "./account-session-control";

const account = {
  displayEmail: "hishou@kazeous.com",
  displayName: "Hishou",
};

const states: ReadonlyArray<{
  label: string;
  state: AccountControlState;
  buttonClassName?: string;
}> = [
  { label: "Default", state: "idle" },
  { label: "Hover", state: "idle", buttonClassName: "is-hover" },
  { label: "Focus", state: "idle", buttonClassName: "is-focus" },
  { label: "Active", state: "idle", buttonClassName: "is-active" },
  { label: "Disabled", state: "disabled" },
  { label: "Loading", state: "loading" },
  { label: "Error", state: "error" },
  { label: "Success", state: "success" },
];

export function AccountSessionControlPreview() {
  return (
    <section className="stack" aria-label="Account session control — 8 states">
      {states.map((item) => (
        <article className="work-surface stack compact" key={item.label}>
          <h2>{item.label}</h2>
          <AccountSessionControlView
            account={account}
            action={{ href: "/settings/security", label: "Bảo mật" }}
            buttonClassName={item.buttonClassName}
            state={item.state}
          />
        </article>
      ))}
    </section>
  );
}
