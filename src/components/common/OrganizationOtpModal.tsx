import { type Component, createEffect, createSignal, Show } from "solid-js";
import { organizationOtpService } from "@/services/organization-otp";

export const OrganizationOtpModal: Component = () => {
  const pending = () => organizationOtpService.pendingRequest();
  const isProcessing = () => organizationOtpService.isProcessing();
  const errorMessage = () => organizationOtpService.errorMessage();
  const [code, setCode] = createSignal("");

  createEffect(() => {
    const request = pending();
    if (!request) {
      setCode("");
      return;
    }

    setCode("");
  });

  const handleSubmit = async () => {
    await organizationOtpService.submitCode(code());
  };

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget && !isProcessing()) {
      organizationOtpService.cancel();
    }
  };

  const title = () => {
    const request = pending();
    if (!request) return "Organization OTP";
    return request.phase === "enroll"
      ? "Set Up Organization OTP"
      : "Verify Organization OTP";
  };

  return (
    <Show when={pending()}>
      {(request) => (
        <div
          class="fixed inset-0 bg-black/70 flex items-center justify-center z-[4000] backdrop-blur-[4px]"
          onClick={handleBackdropClick}
        >
          <div
            class="bg-popover border border-border-strong rounded-2xl p-6 max-w-[440px] w-[92%] shadow-[0_16px_48px_rgba(0,0,0,0.42)]"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="organization-otp-modal-title"
          >
            <div class="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2
                  id="organization-otp-modal-title"
                  class="m-0 text-[1.2rem] font-semibold text-foreground"
                >
                  {title()}
                </h2>
                <p class="m-0 mt-2 text-[0.92rem] leading-relaxed text-muted-foreground">
                  {request().helperText ?? request().denial.message}
                </p>
              </div>
              <button
                type="button"
                class="flex items-center justify-center w-8 h-8 p-0 bg-transparent border border-border rounded-md text-[20px] text-muted-foreground cursor-pointer transition-all hover:bg-surface-1 hover:text-foreground disabled:opacity-50"
                onClick={() => organizationOtpService.cancel()}
                disabled={isProcessing()}
                aria-label="Close organization OTP prompt"
              >
                &times;
              </button>
            </div>

            <Show when={request().challenge}>
              {(challenge) => (
                <div class="mb-4 p-4 bg-black/20 border border-border rounded-xl flex flex-col gap-4">
                  <Show when={request().qrCodeDataUrl}>
                    {(qrCodeDataUrl) => (
                      <div class="flex justify-center">
                        <img
                          src={qrCodeDataUrl()}
                          alt="Organization OTP QR code"
                          class="w-[220px] h-[220px] rounded-lg bg-white p-3"
                        />
                      </div>
                    )}
                  </Show>

                  <div class="flex flex-col gap-1.5">
                    <span class="text-[0.8rem] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                      Account
                    </span>
                    <span class="text-[0.95rem] text-foreground">
                      {challenge().account_name}
                    </span>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <span class="text-[0.8rem] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                      Manual key
                    </span>
                    <code class="block break-all rounded-lg bg-background/60 border border-border px-3 py-2 text-[0.86rem] text-foreground">
                      {challenge().manual_entry_key}
                    </code>
                  </div>
                </div>
              )}
            </Show>

            <div class="flex flex-col gap-2">
              <label
                class="text-[0.86rem] font-medium text-foreground"
                for="organization-otp-code"
              >
                6-digit code
              </label>
              <input
                id="organization-otp-code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                value={code()}
                onInput={(event) =>
                  setCode(
                    event.currentTarget.value.replace(/\D/g, "").slice(0, 6),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
                class="w-full rounded-xl border border-border bg-background/60 px-4 py-3 text-[1rem] tracking-[0.3em] text-foreground outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
                placeholder="123456"
                disabled={isProcessing()}
              />
            </div>

            <Show when={errorMessage()}>
              <div class="mt-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[0.88rem] text-warning">
                {errorMessage()}
              </div>
            </Show>

            <div class="mt-5 flex gap-3 justify-end">
              <button
                type="button"
                class="px-4 py-2.5 rounded-lg border border-border bg-transparent text-foreground cursor-pointer transition-all hover:bg-surface-1 disabled:opacity-50"
                onClick={() => organizationOtpService.cancel()}
                disabled={isProcessing()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="px-4 py-2.5 rounded-lg border-none bg-accent text-primary-foreground cursor-pointer transition-all hover:bg-primary/85 disabled:opacity-50"
                onClick={() => void handleSubmit()}
                disabled={isProcessing()}
              >
                {isProcessing()
                  ? "Working..."
                  : request().phase === "enroll"
                    ? "Confirm setup"
                    : "Verify"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
