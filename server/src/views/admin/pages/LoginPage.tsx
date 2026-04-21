import { RootLayout } from "../../layouts/RootLayout";

// Login uses RootLayout directly — no sidebar nav, just a centered form.
export function LoginPage() {
  return (
    <RootLayout
      title="Login"
      head={<link rel="stylesheet" href="/static/styles/admin.css" />}
      bodyClass="admin admin--login"
    >
      <main class="login-container">
        <div class="login-card">
          <h1>Admin Login</h1>
          <p class="empty-state">Phase 2 builds the login form here.</p>
        </div>
      </main>
    </RootLayout>
  );
}
