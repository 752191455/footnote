/**
 * Multi-user collaboration spec — verifies two users sign in into
 * separate browser contexts and the app distinguishes them.
 *
 * `users(2)` takes any two accounts from your pool, so this spec passes on a
 * fresh app with no setup beyond having two test accounts:
 *   npx deepspace test accounts list
 *   npx deepspace test accounts create --email a@deepspace.test --name "A" --password-stdin
 *
 * Ask for accounts *by name* (`users(['Alice', 'Bob'])`) only when the
 * behaviour under test depends on which identity acts — otherwise naming them
 * couples the spec to one machine's pool.
 *
 * The `users` fixture handles sign-in caching (per-account storageState
 * persisted to `~/.deepspace/playwright-states/`), context creation, and
 * cleanup. No need to manage browser contexts manually.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

// A machine that has never created test accounts is the normal state of a
// fresh checkout, and there `users()` throws — turning "you have no pool yet"
// into three red tests about the app, which it is not. Skip the file instead
// and say what creates the pool. The count is of accounts usable HERE: the
// pool is global per developer, but passwords live only on the machine that
// created the account.
const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 2,
  `Needs 2 usable test accounts, found ${usableTestAccounts}. Create them with ` +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" ' +
    '--password-stdin`, or fetch existing pool accounts with `npx deepspace test accounts recover --all`.',
)

test('each browser renders its own signed-in account', async ({ users }) => {
  const [a, b] = await users(2)

  // /home is dynamic (under src/pages/(app)/), so it mounts the nav shell;
  // '/' is the static landing and has no navigation.
  await Promise.all([a.page.goto('/home'), b.page.goto('/home')])

  // Email, not name. The page renders the *session's* `name || email`, while
  // `user.name` here comes from the LOCAL account registry — and the two are
  // not the same fact: a display name is optional, and an account recovered on
  // another machine has none stored locally at all. The email is the credential
  // the context signed in with, so it is the one identity both sides agree on,
  // and asserting it proves the page is showing THIS browser's account.
  // The two accounts are distinct, so two exact matches is also the proof that
  // the contexts are not sharing one session.
  for (const user of [a, b]) {
    await expect(user.page.getByTestId('app-navigation')).toBeVisible({ timeout: 15_000 })

    // The identity chip shows `name || email`. Its text is not predictable, but
    // its presence is: something must be there once the profile has loaded.
    // (It is `hidden sm:inline` in some templates, so assert text, not
    // visibility.)
    await expect(user.page.getByTestId('nav-user-name')).toHaveText(/\S/, { timeout: 15_000 })

    await user.page.getByRole('button', { name: 'Account menu' }).click()
    await expect(user.page.getByTestId('nav-user-email')).toHaveText(user.email, {
      timeout: 15_000,
    })
  }
})

test('API status page renders loading success and error states', async ({ users }) => {
  const [user] = await users(1)
  let shouldFail = false
  let requestCount = 0

  await user.page.route('**/api/integrations', async (route) => {
    requestCount += 1
    if (shouldFail) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Catalog unavailable' }),
      })
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { integrations: { openai: {}, wikipedia: {} } } }),
    })
  })

  await user.page.goto('/api-status')
  await expect(user.page.getByText('Loading integration catalog...')).toBeVisible()
  await expect(user.page.getByText('Integration catalog ready')).toBeVisible()
  await expect(user.page.getByText('2 integrations available.')).toBeVisible()

  shouldFail = true
  await user.page.getByRole('button', { name: 'Refresh' }).click()
  await expect(user.page.getByText('Catalog unavailable')).toBeVisible()
  await expect(user.page.getByText('Showing the last loaded catalog')).toBeVisible()
  await expect(user.page.getByText('Integration catalog ready')).toBeVisible()

  const urlAfterFailure = user.page.url()
  const requestsAfterFailure = requestCount
  await user.page.getByRole('button', { name: 'Refresh' }).click()
  await expect.poll(() => requestCount).toBeGreaterThan(requestsAfterFailure)
  expect(user.page.url()).toBe(urlAfterFailure)
})

test('API status page shows local retry after first-load API failure', async ({ users }) => {
  const [user] = await users(1)
  let requestCount = 0

  await user.page.route('**/api/integrations', async (route) => {
    requestCount += 1
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Catalog unavailable' }),
    })
  })

  await user.page.goto('/api-status')
  await expect(user.page.getByText('Loading integration catalog...')).toBeVisible()
  await expect(user.page.getByText('Could not load API data')).toBeVisible()
  await expect(user.page.getByText('Retried 1 time automatically.')).toBeVisible()

  const retryButton = user.page.getByRole('button', { name: 'Retry' })
  await expect(retryButton).toBeVisible()

  const urlAfterFailure = user.page.url()
  const requestsAfterFailure = requestCount
  await retryButton.click()
  await expect.poll(() => requestCount).toBeGreaterThan(requestsAfterFailure)
  expect(user.page.url()).toBe(urlAfterFailure)
})

/**
 * Full two-player game against the real worker, real Wikipedia, and the real
 * question writer (one generation per run — keep this the only spec that
 * creates a game). Covers: hosting, invite-link join, presence in the lobby,
 * answer secrecy before reveal, the "everyone answered" early reveal, the
 * timer-driven reveal, scoring, and the final standings on both screens.
 */
test('two players play a full game', async ({ users }) => {
  test.setTimeout(180_000)
  const [host, guest] = await users(2)

  // Host writes a short, fast quiz.
  await host.page.goto('/home')
  await host.page.getByLabel('Topic').fill('Octopus')
  await host.page.getByRole('combobox').first().click()
  await host.page.getByRole('option', { name: '5 questions' }).click()
  await host.page.getByRole('combobox').nth(1).click()
  await host.page.getByRole('option', { name: '10 seconds' }).click()
  await host.page.getByTestId('create-game').click()
  await host.page.waitForURL(/\/play\/[A-Z]{4}$/, { timeout: 90_000 })
  const code = (await host.page.getByTestId('room-code').textContent())?.trim()
  expect(code).toMatch(/^[A-Z]{4}$/)

  // Guest follows the invite link and is seated automatically.
  await guest.page.goto(`/play/${code}`)
  for (const u of [host, guest]) {
    await expect(u.page.getByTestId('lobby-players').locator('li')).toHaveCount(2, { timeout: 20_000 })
  }

  await host.page.getByTestId('start-game').click()

  const room = (u: typeof host) => u.page.getByTestId('game-room')
  let questionCount = 0
  for (let round = 0; round < 12; round++) {
    for (const u of [host, guest]) {
      await expect(u.page.getByTestId('question-phase')).toBeVisible({ timeout: 20_000 })
      // Secrecy: nothing on the page marks a correct answer before the reveal.
      await expect(u.page.locator('[data-correct]')).toHaveCount(0)
    }
    questionCount++

    await host.page.getByTestId('choice-0').click()
    if (round === 1) {
      // Guest sits this one out — the round must close on the timer alone.
      await expect(guest.page.getByTestId('reveal-phase')).toBeVisible({ timeout: 20_000 })
      await expect(guest.page.getByTestId('round-result')).toContainText('No answer in time')
    } else {
      await guest.page.getByTestId('choice-1').click()
      // Both answered → the round closes early, well before the 10s timer.
      await expect(guest.page.getByTestId('reveal-phase')).toBeVisible({ timeout: 8_000 })
    }
    await expect(host.page.getByTestId('reveal-phase')).toBeVisible({ timeout: 10_000 })
    for (const u of [host, guest]) {
      await expect(u.page.locator('[data-correct]')).toHaveCount(1)
      await expect(u.page.getByTestId('footnote')).toContainText('Wikipedia')
    }

    await host.page.getByTestId('next-question').click()
    const status = await Promise.race([
      expect(room(host)).toHaveAttribute('data-status', 'finished', { timeout: 10_000 }).then(() => 'finished'),
      expect(room(host)).toHaveAttribute('data-status', 'question', { timeout: 10_000 }).then(() => 'question'),
    ])
    if (status === 'finished') break
  }

  expect(questionCount).toBeGreaterThanOrEqual(3)
  for (const u of [host, guest]) {
    await expect(u.page.getByTestId('finished-phase')).toBeVisible({ timeout: 10_000 })
    await expect(u.page.getByTestId('winner')).toBeVisible()
    await expect(u.page.getByTestId('scoreboard').locator('li')).toHaveCount(2)
  }
})
