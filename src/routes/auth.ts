import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { supabase, Tables } from "../lib/db.js";
import { signToken } from "../lib/jwt.js";

export const authRouter = Router();

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

authRouter.post("/signup", async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password (min 8 chars)" });
  }
  const { email, password } = parsed.data;

  // Check for existing user
  const { data: existing } = await supabase
    .from(Tables.users)
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const { data: user, error } = await supabase
    .from(Tables.users)
    .insert({ email, password_hash: passwordHash })
    .select("id, email")
    .single();

  if (error || !user) {
    console.error("Signup insert failed:", error?.message);
    return res.status(500).json({ error: "Failed to create account" });
  }

  const token = signToken({ userId: user.id });
  res.status(201).json({ token, user: { id: user.id, email: user.email } });
});

authRouter.post("/login", async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password" });
  }
  const { email, password } = parsed.data;

  const { data: user } = await supabase
    .from(Tables.users)
    .select("id, email, password_hash")
    .eq("email", email)
    .maybeSingle();

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ userId: user.id });
  res.json({ token, user: { id: user.id, email: user.email } });
});
