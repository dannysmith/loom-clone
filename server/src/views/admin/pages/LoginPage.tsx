import { RootLayout } from "../../layouts/RootLayout";

// Login uses RootLayout directly — no sidebar nav, just a centered form.
export function LoginPage({ error }: { error?: string }) {
  return (
    <RootLayout
      title="Login"
      head={<link rel="stylesheet" href="/static/styles/admin.css" />}
      bodyClass="admin admin--login"
    >
      <main class="login-container">
        <div class="login-card">
          <h1>Admin Login</h1>
          {error && <p class="form-error">{error}</p>}
          <form method="post" action="/admin/login" class="login-form">
            <div class="form-field">
              <label class="label" for="username">
                Username
              </label>
              <input
                class="input"
                id="username"
                name="username"
                type="text"
                autocomplete="username"
                required
              />
            </div>
            <div class="form-field">
              <label class="label" for="password">
                Password
              </label>
              <input
                class="input"
                id="password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
              />
            </div>
            <button class="btn btn--primary login-submit" type="submit">
              Log in
            </button>
          </form>
        </div>
      </main>
    </RootLayout>
  );
}
