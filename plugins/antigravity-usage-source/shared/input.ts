import { z } from "zod";
export const inputSchema = z.object({ store: z.literal("agy-cli") }).strict();
export type UsageInput = z.infer<typeof inputSchema>;
