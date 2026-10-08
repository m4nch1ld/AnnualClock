import { expect, test, type Page } from "@playwright/test";

async function demoLogin(page: Page, name: RegExp, next = "/clocks") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByRole("button", { name }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("Environmental director sees the EUA deadlines on the wheel and in the list", async ({ page }) => {
  await demoLogin(page, /Emma Environmental/, "/clocks/environmental?year=2027");
  await expect(page.getByRole("heading", { name: "Environmental", level: 1 })).toBeVisible();

  // Wheel: activities are exposed as labelled buttons
  const wheel = page.getByRole("group", { name: /Annual clock for Environmental, 2027/ });
  await expect(wheel).toBeVisible();
  await expect(wheel.getByRole("button", { name: /EUA verification due, 31 Mar 2027/ })).toBeVisible();
  await expect(wheel.getByRole("button", { name: /EUA submission \/ surrender due, 30 Sept 2027/ })).toBeVisible();

  // Open details from the wheel by keyboard
  await wheel.getByRole("button", { name: /EUA verification due/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "EUA verification due" })).toContainText("every year");

  // List view is the keyboard-accessible equivalent
  await page.getByRole("tab", { name: "List" }).click();
  await expect(page.getByRole("table")).toContainText("EUA submission / surrender due");
  await expect(page.getByRole("button", { name: "New activity", exact: false })).toBeVisible();
});

test("General management reads every clock but cannot edit; no access leaks to clocks a user is not in", async ({ page }) => {
  await demoLogin(page, /Greta General Management/);
  await expect(page.getByRole("heading", { name: "Your clocks" })).toBeVisible();
  for (const name of ["Operations", "Chartering", "Crewing", "Technical", "Environmental", "Safety", "Shipbuilding", "General management"]) {
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await page.goto("/clocks/safety");
  await expect(page.getByText("You have read-only access to this clock.")).toBeVisible();
  await expect(page.getByRole("button", { name: /New activity/ })).toHaveCount(0);

  // A crewing editor cannot open the Safety clock at all (RLS → 404)
  await page.request.post("/auth/signout");
  await demoLogin(page, /Carl Crewing/);
  const res = await page.goto("/clocks/safety");
  expect(res?.status()).toBe(404);
  const csv = await page.request.get("/api/clocks/safety/export");
  expect(csv.status()).toBe(404);
});
