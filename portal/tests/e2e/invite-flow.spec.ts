import { test, expect } from "@playwright/test";

const ADMIN_URL = "http://localhost:3001";

/**
 * ── ⚠ THESE TWO PASSWORDS ARE NOT CREDENTIALS, AND THIS NOTE IS WHY ─────────────────────────────
 *
 * An ASH scan flagged the literal below — correctly, on its face: it is a password-shaped string in a
 * committed file. Triaged and confirmed: both accounts are CREATED BY THIS SPEC against an
 * ephemeral/dev Cognito user pool, under timestamped addresses (`admin-${ts}@…`, `invitee-${ts}@…`)
 * that exist only for the duration of a run. The value grants nothing anywhere a person uses.
 *
 * Recorded here rather than suppressed in `.ash/.ash.yaml`, deliberately: a path-based ignore over
 * `tests/**` would blind detect-secrets to a REAL credential landing in a test file later, which is
 * one of the commoner ways secrets actually get committed. A note at the line keeps the rest scanned.
 *
 * ⚠ IF THIS SPEC IS EVER POINTED AT A SHARED OR PRODUCTION POOL, this becomes a disclosed credential
 * — and deleting the line does NOT undisclose it, because it is in git history on a hosted remote.
 * Rotate first, then remove.
 */
const ts = Date.now();
const admin = {
  firstName: "Admin",
  lastName: "Tester",
  email: `admin-${ts}@example.com`,
  password: "Test@1234",
  organization: "TestOrg",
};

const invitee = {
  firstName: "Invited",
  lastName: "User",
  email: `invitee-${ts}@example.com`,
  password: "Test@1234",
  organization: "TestOrg",
};

let workshopId: string;
let teamId: string;
let inviteCode: string;

async function login(page: any, email: string, password: string) {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page).toHaveURL(/\/workshops/, { timeout: 10000 });
}

test.describe.serial("Full Invite Flow", () => {
  test("1. Admin registers an account", async ({ page }) => {
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByRole("button", { name: /Don't have an account/i }).click();

    await page.getByPlaceholder("John").fill(admin.firstName);
    await page.getByPlaceholder("Doe").fill(admin.lastName);
    await page.getByPlaceholder("Acme Corp").fill(admin.organization);
    await page.getByPlaceholder("you@example.com").fill(admin.email);
    await page.getByPlaceholder("••••••••").fill(admin.password);
    await page.getByRole("button", { name: "Create Account", exact: true }).click();

    await expect(page).toHaveURL(/\/workshops/, { timeout: 10000 });
    await expect(page.getByText("My Experiences")).toBeVisible();
  });

  test("2. Admin creates an experience", async ({ page }) => {
    await login(page, admin.email, admin.password);

    await page.getByRole("link", { name: /Create Experience/i }).first().click();
    await expect(page).toHaveURL(/\/workshops\/new/);

    await page.getByPlaceholder("e.g., AI Innovation Sprint Q3").fill("E2E Test Workshop");
    await page.getByPlaceholder("Describe the goals").fill("Testing the full invite flow");
    await page.locator("select").selectOption("HACKATHON");
    await page.getByRole("button", { name: "Create Experience", exact: true }).click();

    // Wait for redirect to workshop detail (not /new)
    await page.waitForURL(/\/workshops\/(?!new)/, { timeout: 15000 });
    workshopId = page.url().split("/workshops/")[1];
    expect(workshopId).toBeTruthy();
    expect(workshopId).not.toBe("new");
  });

  test("3. Admin creates a team", async ({ page }) => {
    await login(page, admin.email, admin.password);
    await page.goto(`${ADMIN_URL}/workshops/${workshopId}`);

    await page.getByRole("button", { name: "Create Team", exact: true }).click();
    await page.getByPlaceholder("Team name").fill("Alpha Team");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page).toHaveURL(/\/w\/.*\/t\//, { timeout: 10000 });
    const url = page.url();
    teamId = url.split("/t/")[1].split("/")[0].split("?")[0];
    expect(teamId).toBeTruthy();
  });

  test("4. Admin views team tab and gets invite code", async ({ page }) => {
    await login(page, admin.email, admin.password);
    await page.goto(`${ADMIN_URL}/w/${workshopId}/t/${teamId}/team`);

    await expect(page.getByText("Invite Members")).toBeVisible({ timeout: 10000 });

    const codeElement = page.locator(".font-mono.tracking-widest");
    inviteCode = (await codeElement.textContent())?.trim() || "";
    expect(inviteCode.length).toBeGreaterThan(0);
  });

  test("5. Admin sends email invitations", async ({ page }) => {
    await login(page, admin.email, admin.password);
    await page.goto(`${ADMIN_URL}/w/${workshopId}/t/${teamId}/team`);

    await expect(page.getByText("Invite Members")).toBeVisible({ timeout: 10000 });

    const emailInput = page.locator("#email-input");
    await emailInput.fill(invitee.email);
    await emailInput.press("Space");
    await expect(page.getByText(invitee.email)).toBeVisible();

    await emailInput.fill("another@example.com");
    await emailInput.press("Space");

    await page.getByRole("button", { name: /Send Invite/i }).click();
    await expect(page.getByText(/Invitations sent/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Pending").first()).toBeVisible();
  });

  test("6. Invitee registers and joins team", async ({ page }) => {
    // Register
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByRole("button", { name: /Don't have an account/i }).click();

    await page.getByPlaceholder("John").fill(invitee.firstName);
    await page.getByPlaceholder("Doe").fill(invitee.lastName);
    await page.getByPlaceholder("Acme Corp").fill(invitee.organization);
    await page.getByPlaceholder("you@example.com").fill(invitee.email);
    await page.getByPlaceholder("••••••••").fill(invitee.password);
    await page.getByRole("button", { name: "Create Account", exact: true }).click();
    await expect(page).toHaveURL(/\/workshops/, { timeout: 10000 });

    // Go to workshop and join
    await page.goto(`${ADMIN_URL}/workshops/${workshopId}`);
    await page.getByRole("button", { name: "Join with Code", exact: true }).click();
    await page.getByPlaceholder("Paste invite code").fill(inviteCode);
    await page.getByRole("button", { name: "Join", exact: true }).click();

    await expect(page).toHaveURL(/\/w\/.*\/t\//, { timeout: 10000 });
  });

  test("7. Admin sees invitation accepted", async ({ page }) => {
    await login(page, admin.email, admin.password);
    await page.goto(`${ADMIN_URL}/w/${workshopId}/t/${teamId}/team`);

    await expect(page.getByText("Accepted").first()).toBeVisible({ timeout: 10000 });
  });
});
