import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TableauClient } from "../src/tableau/client.js";
import { tryFastPath, FastPathResult } from "../src/lib/queryRouter.js";

/**
 * Comprehensive Query Test Harness.
 * Runs every documented query from QUERY_GUIDE.md + QUERY_EXAMPLES.md through
 * the platform's fast-path router with a mock Tableau backend.
 * Writes results to: byok-platform/QUERY_TEST_RESULTS.md
 */
process.env.REDIS_URL = "";

const WBs = [
  { id: "wb1", name: "Sales Overview", description: "Monthly sales by region with a rolling forecast." },
  { id: "wb2", name: "Marketing Funnel", description: "Leads, MQLs and opportunities." },
  { id: "wb3", name: "Ops Metrics", description: null },
  { id: "wb4", name: "Finance Q3 Report", description: "Quarterly financial performance." },
  { id: "wb5", name: "Executive Dashboard", description: "High-level KPIs and trend charts." },
  { id: "wb6", name: "HR Analytics", description: "Employee headcount, retention, compensation." },
  { id: "wb7", name: "Product Performance", description: "Sales and usage metrics by product." },
];
const DSs = [
  { id: "58a2528c-6e9e-4a2b-9f51-cf9a89a1d2e1", name: "Sales Data", description: "Primary ERP source.", isEmbedded: false, hasExtract: true },
  { id: "c9b14e73-2a9d-4d63-8c01-4f6b7d28a91c", name: "Marketing Data", description: null, isEmbedded: false, hasExtract: false },
  { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", name: "HR Analytics", description: "Employee and payroll data.", isEmbedded: true, hasExtract: true },
  { id: "f00d1234-5678-9abc-def0-123456789abc", name: "Finance Data", description: "GL and budget data.", isEmbedded: false, hasExtract: true },
];
