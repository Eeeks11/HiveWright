import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import postgres from "postgres";
import { verifyCredentials } from "./auth/users";
import { authConfig } from "./auth.config";

// Dedicated SQL handle so auth.ts doesn't depend on the shared API-layer pool.
// NextAuth runs before request handlers, so using the singleton here could
// deadlock during cold start.
function db() {
  return postgres(
    process.env.DATABASE_URL ||
      "postgresql://hivewright@localhost:5432/hivewrightv2",
    { max: 2 },
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "Email + password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const sql = db();
        try {
          const email = (credentials?.email as string | undefined) ?? "";
          const password = (credentials?.password as string | undefined) ?? "";

          if (!email || !password) return null;
          const user = await verifyCredentials(sql, email, password);
          if (!user) return null;
          return {
            id: user.id,
            name: user.displayName ?? user.email,
            email: user.email,
          };
        } finally {
          await sql.end({ timeout: 1 });
        }
      },
    }),
  ],
});
