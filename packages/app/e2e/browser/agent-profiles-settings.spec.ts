import { expect, test, type Page } from "../support/fixtures";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  selectNewWorkspaceProject,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  agentProfileRow,
  createAgentProfile,
  createAgentProfileFromEmptyState,
  editAgentProfile,
  expectAgentProfile,
  expectAgentProfileForm,
  expectAgentProfileOrder,
  expectAgentProfileTagsGone,
  expectHostAgentProfiles,
  expectNoAgentProfiles,
  moveAgentProfileUp,
  openAgentProfileSettings,
  removeAgentProfile,
  seedAgentProfiles,
  stageLegacyFavoritesForHostMigration,
} from "../support/helpers/agent-profiles";

const MOCK_PROVIDER_LABEL = "Mock Load Test";

test.describe("Agent profiles settings", () => {
  test("legacy model favourites migrate into provider-and-model-only host profiles", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([]);
    const migratedProfile = {
      id: "legacy_favorite:mock:one-minute-stream",
      name: "One minute stream",
      provider: "mock",
      model: "one-minute-stream",
    };

    try {
      await stageLegacyFavoritesForHostMigration(page, [
        { provider: "mock", modelId: "one-minute-stream" },
      ]);

      await expectHostAgentProfiles([migratedProfile]);
      await openAgentProfileSettings(page);
      await expectAgentProfile(page, {
        name: migratedProfile.name,
        tags: [MOCK_PROVIDER_LABEL, "One minute stream"],
      });
    } finally {
      await seed.restore();
    }
  });

  test("editing a scoped profile preserves its context policy", async ({ page }) => {
    const profile = {
      id: "scoped-profile-edit",
      name: "Scoped review",
      provider: "mock",
      model: "one-minute-stream",
      modeId: "approval-test",
      notes: "Before edit",
      contextPolicy: {
        providerWindowTokens: 1000000,
        clientWindowTokens: 1000000,
        outputReserveTokens: 32000,
        thresholdTokens: 512000,
      },
    };
    const seed = await seedAgentProfiles([profile]);
    try {
      await openAgentProfileSettings(page);
      await editAgentProfile(page, profile.name, { notes: "After edit" });
      await expectHostAgentProfiles([{ ...profile, notes: "After edit" }]);
    } finally {
      await seed.restore();
    }
  });

  test("host owner creates, edits, reorders and removes agent profiles", async ({ page }) => {
    // The journey owns the list, so it starts from an empty one whatever the
    // worker ran before, and hands it back untouched.
    const seed = await seedAgentProfiles([]);

    try {
      await test.step("the section starts empty", async () => {
        await openAgentProfileSettings(page);
        await expectNoAgentProfiles(page);
      });

      await test.step("create a profile from the modal", async () => {
        await createAgentProfileFromEmptyState(page, {
          name: "UI work",
          provider: MOCK_PROVIDER_LABEL,
          model: "Ten second stream",
          thinking: "High",
          mode: "Approval test",
          notes: "Use for UI work — components, layout and design tokens.",
        });
        await expectAgentProfile(page, {
          name: "UI work",
          tags: [MOCK_PROVIDER_LABEL, "Ten second stream", "Approval test", "High"],
          notes: "Use for UI work — components, layout and design tokens.",
        });
      });

      await test.step("editing to a model without thinking levels drops the level", async () => {
        await editAgentProfile(page, "UI work", {
          model: "One minute stream",
          notes: "Now for quick checks.",
        });
        await expectAgentProfile(page, {
          name: "UI work",
          tags: [MOCK_PROVIDER_LABEL, "One minute stream", "Approval test"],
          notes: "Now for quick checks.",
        });
        await expectAgentProfileTagsGone(page, {
          name: "UI work",
          tags: ["Ten second stream", "High"],
        });
      });

      await test.step("the edit form reopens on what was stored", async () => {
        await expectAgentProfileForm(page, "UI work", {
          provider: MOCK_PROVIDER_LABEL,
          model: "One minute stream",
          mode: "Approval test",
          notes: "Now for quick checks.",
        });
      });

      await test.step("a second profile lands below the first", async () => {
        await createAgentProfile(page, {
          name: "Deep review",
          provider: MOCK_PROVIDER_LABEL,
          model: "Five minute stream",
        });
        await expectAgentProfileOrder(page, ["UI work", "Deep review"]);
      });

      await test.step("reorder puts the second profile on top", async () => {
        await moveAgentProfileUp(page, "Deep review");
        await expectAgentProfileOrder(page, ["Deep review", "UI work"]);
      });

      await test.step("removing a profile confirms by name", async () => {
        await removeAgentProfile(page, "UI work");
        await expectAgentProfileOrder(page, ["Deep review"]);
      });

      await test.step("removing the last profile returns the empty state", async () => {
        await removeAgentProfile(page, "Deep review");
        await expectNoAgentProfiles(page);
      });
    } finally {
      await seed.restore();
    }
  });
});

async function openRoleProfileEditor(page: Page, name: string): Promise<void> {
  await page.goto(buildSettingsHostSectionRoute(getServerId(), "agents"));
  await agentProfileRow(page, name)
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible();
}

async function selectProfilePolicyOption(
  page: Page,
  field: "role" | "context",
  option: string,
): Promise<void> {
  await page.getByTestId(`agent-profile-${field}-trigger`).click();
  await page.getByTestId(`agent-profile-${field}-option-${option}`).click();
}

for (const surface of [
  { name: "desktop", viewport: { width: 1440, height: 1000 } },
  { name: "compact", viewport: { width: 390, height: 844 } },
]) {
  test(`role profiles preserve launch responsibility on ${surface.name}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize(surface.viewport);
    const profile: AgentProfile = {
      id: "role-profile-launch",
      name: "Astra",
      provider: "mock",
      model: "ten-second-stream",
      modeId: "load-test",
      thinkingOptionId: "low",
    };
    const contextPolicy = {
      providerWindowTokens: 1000000,
      clientWindowTokens: 1000000,
      outputReserveTokens: 32000,
      thresholdTokens: 512000,
    };
    const seed = await seedAgentProfiles([profile]);
    const workspace = await seedWorkspace({ repoPrefix: "role-profile-launch-", git: false });
    const client = await connectDaemonClient<
      Pick<DaemonClient, "connect" | "close" | "fetchAgents" | "fetchAgent">
    >({ clientIdPrefix: "role-profile-snapshot" });
    try {
      await test.step("edit role and validate explicit context before saving", async () => {
        await openRoleProfileEditor(page, profile.name);
        await selectProfilePolicyOption(page, "role", "ustad");
        await selectProfilePolicyOption(page, "context", "explicit");
        const modal = page.getByTestId("agent-profile-edit-modal");
        for (const [field, tokens] of Object.entries(contextPolicy)) {
          await page.getByTestId(`agent-profile-${field}-input`).fill(String(tokens));
        }
        await page.getByTestId("agent-profile-thresholdTokens-input").fill("999999");
        await expect(page.getByTestId("agent-profile-context-error")).toContainText(
          "Threshold must fit",
        );
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await page.getByTestId("agent-profile-thresholdTokens-input").fill("512000");
        await expect(page.getByTestId("agent-profile-context-error")).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`${surface.name}-profile-editor.png`),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(modal).toHaveCount(0);
        await expectHostAgentProfiles([{ ...profile, role: "ustad", contextPolicy }]);
      });

      await test.step("clear explicit context deliberately without removing role", async () => {
        await openRoleProfileEditor(page, profile.name);
        await expect(page.getByTestId("agent-profile-providerWindowTokens-input")).toHaveValue(
          "1000000",
        );
        await selectProfilePolicyOption(page, "context", "host-default");
        await expect(page.getByTestId("agent-profile-providerWindowTokens-input")).toHaveCount(0);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expectHostAgentProfiles([{ ...profile, role: "ustad" }]);
      });

      await test.step("find the role and variant together and launch the selected profile", async () => {
        await page.goto("/new");
        await selectNewWorkspaceProject(page, workspace);
        await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
        const search = page
          .getByTestId("model-search-all-input")
          .or(page.getByTestId("model-search-input"))
          .filter({ visible: true });
        await search.fill("ustad mock astra");
        const row = page.getByTestId(`model-profile-row-${profile.id}`);
        await expect(row).toBeVisible();
        await expect(row).toContainText("Ustad");
        await page.screenshot({
          path: testInfo.outputPath(`${surface.name}-role-search.png`),
          fullPage: true,
        });
        await row.click();
        await submitNewWorkspacePrompt(page, "Report the test adapter status.");
        await expect(page.getByTestId("agent-launch-details-trigger")).toHaveText("Ustad", {
          timeout: 30000,
        });
      });

      const agents = await client.fetchAgents({ scope: "active" });
      expect(agents.entries).toHaveLength(1);
      const agent = agents.entries[0]!.agent;
      expect(agent.role).toBe("ustad");
      expect(agent.contextPolicy).toBeUndefined();
      const agentWorkspaceId = agent.workspaceId;
      if (!agentWorkspaceId) throw new Error("Created agent must belong to its workspace");

      await test.step("later profile edits leave the saved agent role unchanged", async () => {
        await openRoleProfileEditor(page, profile.name);
        await page.getByTestId("agent-profile-name-input").fill("Renamed Astra");
        await selectProfilePolicyOption(page, "role", "shagird");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expectHostAgentProfiles([{ ...profile, name: "Renamed Astra", role: "shagird" }]);
        const saved = await client.fetchAgent({ agentId: agent.id });
        expect(saved?.agent.role).toBe("ustad");
        await gotoWorkspace(page, agentWorkspaceId);
        await page.getByTestId("agent-launch-details-trigger").click();
        await expect(page.getByTestId("agent-launch-details")).toBeVisible();
        await expect(page.getByText("Role at creation", { exact: true })).toBeInViewport({
          ratio: 1,
        });
        await expect(page.getByText("Ustad", { exact: true }).last()).toBeVisible();
        await expect(page.getByText("Shagird", { exact: true })).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`${surface.name}-saved-role.png`),
          fullPage: true,
        });
      });
    } finally {
      await client.close();
      await workspace.cleanup();
      await seed.restore();
    }
  });
}
