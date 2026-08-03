// ABOUTME: Critical regression coverage for conversational Gmail sender confirmation.
// ABOUTME: Keeps account choice private while giving agents an explicit selector contract.

import { describe, expect, it } from "vitest";
import {
  buildOAuthAccountConfirmationInstruction,
  extractGmailProfileEmail,
  gmailProfileMatchesConnection,
  isGmailSendTool,
  OAUTH_ACCOUNT_GUIDANCE_HEADER,
} from "@/lib/agent/oauth-account-guidance";
import type { AgentOAuthRouting } from "@/services/providers";

const routing: AgentOAuthRouting = {
  publishers: { gmail: "conn-primary" },
  ambiguous: {},
  available: true,
  accounts: {
    gmail: {
      providerSlug: "google",
      providerName: "Google",
      activeConnectionId: "conn-primary",
      selectionSource: "default",
      connections: [
        {
          connectionId: "conn-primary",
          label: "primary@example.test",
          isDefault: true,
        },
        {
          connectionId: "conn-secondary",
          label: "secondary@example.test",
          isDefault: false,
        },
      ],
    },
  },
};

describe("OAuth account confirmation guidance (#3589)", () => {
  it("recognizes only the live Gmail send tool slugs", () => {
    expect(isGmailSendTool("gmail", "post_send")).toBe(true);
    expect(isGmailSendTool("gmail", "post_messages_send")).toBe(true);
    expect(
      isGmailSendTool("gmail", "post_drafts_by_draft_id_send"),
    ).toBe(true);
    expect(isGmailSendTool("gmail", "get_messages")).toBe(false);
    expect(isGmailSendTool("outlook", "post_send")).toBe(false);
  });

  it("requires a later sender confirmation and profile check before Gmail sends", () => {
    const guidance = buildOAuthAccountConfirmationInstruction(routing);

    expect(guidance).toContain(OAUTH_ACCOUNT_GUIDANCE_HEADER);
    expect(guidance).toContain("primary@example.test");
    expect(guidance).toContain("secondary@example.test");
    expect(guidance).toContain("Stop and wait for a later user reply");
    expect(guidance).toContain(
      "The original request to send is not sender confirmation",
    );
    expect(guidance).toContain("gmail/get_profile");
    expect(guidance).toContain("same human turn");
    expect(guidance).toContain("top-level connection_id");
    expect(guidance).toContain("Never expose");
  });

  it("omits guidance when the thread has no Gmail account metadata", () => {
    expect(
      buildOAuthAccountConfirmationInstruction({
        publishers: {},
        ambiguous: {},
        accounts: {},
        available: true,
      }),
    ).toBeNull();
  });

  it("accepts only a profile identity that matches the selected connected account", () => {
    expect(
      extractGmailProfileEmail(
        [
          {
            type: "text",
            text: JSON.stringify({
              data: { emailAddress: "primary@example.test" },
            }),
          },
        ],
      ),
    ).toBe("primary@example.test");
    expect(
      gmailProfileMatchesConnection(
        routing,
        "conn-primary",
        "PRIMARY@example.test",
      ),
    ).toBe(true);
    expect(
      gmailProfileMatchesConnection(
        routing,
        "conn-primary",
        "secondary@example.test",
      ),
    ).toBe(false);
    expect(extractGmailProfileEmail({ status: "ok" })).toBeNull();
  });
});
