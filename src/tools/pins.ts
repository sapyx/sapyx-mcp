// ============================================================
// MCP Tools — Pinterest Pins
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listBoardPins,
  listSectionPins,
  getPin,
  updatePin,
  deletePin,
  savePin,
  createPin,
  getPinAnalytics,
  getUserTopPins,
  fetchImageAsBase64,
  fetchImageHash,
} from "../api.js";
import { createHash } from "node:crypto";
import type { ImageSizeKey, Pin, TopPinsAnalyticsResponse } from "../types.js";
import { handleToolError } from "./utils.js";

/**
 * Returns the best available image URL from a pin, or null if none.
 */
function getBestImageUrl(pin: Pin): string | null {
  const images = pin.media?.images;
  if (!images) return null;
  return images.originals?.url ?? images["1200x"]?.url ?? images["600x"]?.url ?? images["400x300"]?.url ?? null;
}

/**
 * Scans a board (or section) for a pin whose image matches the given SHA-256 hash.
 * Returns the first match found, or null if none.
 * Skips `excludePinId` (the source pin itself).
 */
async function findDuplicateInBoard(
  imageHash: string,
  boardId: string,
  sectionId?: string,
  excludePinId?: string,
): Promise<Pin | null> {
  let bookmark: string | undefined;
  do {
    const page = sectionId
      ? await listSectionPins(boardId, sectionId, 100, bookmark)
      : await listBoardPins(boardId, 100, bookmark);

    for (const pin of page.items) {
      if (pin.id === excludePinId) continue;
      const url = getBestImageUrl(pin);
      if (!url) continue;
      try {
        const hash = await fetchImageHash(url);
        if (hash === imageHash) return pin;
      } catch {
        // ignore fetch errors for individual pins
      }
    }
    bookmark = page.bookmark ?? undefined;
  } while (bookmark);

  return null;
}

/** Format a pin summary for listing */
function formatPinSummary(pin: Pin): string {
  const title = pin.title || "(no title)";
  const desc = pin.description
    ? pin.description.length > 80
      ? pin.description.substring(0, 80) + "…"
      : pin.description
    : "(no description)";
  const type = pin.creative_type ?? "unknown";
  const loc = pin.board_section_id ? `section:${pin.board_section_id}` : "root";
  return `[${pin.id}] "${title}" — ${desc} [${type}] [${loc}]`;
}

/** Format full pin details */
function formatPinDetails(pin: Pin): string {
  const lines: string[] = [
    `Pin Details:`,
    `  ID: ${pin.id}`,
    `  Title: ${pin.title ?? "(none)"}`,
    `  Description: ${pin.description ?? "(none)"}`,
    `  Alt Text: ${pin.alt_text ?? "(none)"}`,
    `  Link: ${pin.link ?? "(none)"}`,
    `  Board ID: ${pin.board_id}`,
    `  Section ID: ${pin.board_section_id ?? "(none)"}`,
    `  Type: ${pin.creative_type ?? "unknown"}`,
    `  Created: ${pin.created_at}`,
    `  Dominant Color: ${pin.dominant_color ?? "unknown"}`,
  ];

  if (pin.media) {
    lines.push(`  Media Type: ${pin.media.media_type}`);
    if (pin.media.images) {
      lines.push(`  Image URLs:`);
      for (const [size, img] of Object.entries(pin.media.images)) {
        if (img) {
          lines.push(`    ${size}: ${img.url} (${img.width}x${img.height})`);
        }
      }
    }
  }

  return lines.join("\n");
}

export function registerPinTools(server: McpServer, scopes: Set<string>): void {
  const canRead = scopes.has("pins:read") || scopes.has("pins:read_secret");
  const canWrite = scopes.has("pins:write") || scopes.has("pins:write_secret");

  // --- list_pins ---
  if (canRead) {
    server.tool(
      "list_pins",
      "List pins on a board or board section.",
      {
        board_id: z.string().describe("Board ID"),
        section_id: z.string().optional().describe("Section ID (omit for all board pins)"),
        page_size: z.number().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        bookmark: z.string().optional().describe("Pagination cursor from previous response"),
        root_only: z.boolean().optional().describe("If true, return only root-level pins (no section). Only applies when section_id is not set."),
      },
      async ({ board_id, section_id, page_size, bookmark, root_only }) => {
        try {
          const result = section_id
            ? await listSectionPins(board_id, section_id, page_size, bookmark)
            : await listBoardPins(board_id, page_size, bookmark);

          const items = root_only && !section_id
            ? result.items.filter((p) => !p.board_section_id)
            : result.items;

          if (items.length === 0) {
            return { content: [{ type: "text" as const, text: "No pins found." }] };
          }

          const lines = items.map(formatPinSummary);
          if (result.bookmark) lines.push(`\n--- More results. bookmark: "${result.bookmark}" ---`);

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- get_pin ---
  if (canRead) {
    server.tool(
      "get_pin",
      "Get full details of a specific pin including image URLs.",
      {
        pin_id: z.string().describe("Pin ID"),
      },
      async ({ pin_id }) => {
        try {
          const pin = await getPin(pin_id);
          return { content: [{ type: "text" as const, text: formatPinDetails(pin) }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- get_pin_image ---
  if (canRead) {
    server.tool(
      "get_pin_image",
      "Fetch a pin's image so it can be analyzed visually. Returns the image as viewable content.",
      {
        pin_id: z.string().describe("Pin ID"),
        size: z
          .enum(["150x150", "400x300", "600x", "1200x", "originals"])
          .optional()
          .describe("Image size variant (default: 600x)"),
      },
      async ({ pin_id, size }) => {
        try {
          const selectedSize: ImageSizeKey = (size as ImageSizeKey) ?? "600x";
          const pin = await getPin(pin_id);

          if (!pin.media?.images) {
            return { content: [{ type: "text" as const, text: "This pin has no image media." }], isError: true };
          }

          const imageInfo = pin.media.images[selectedSize] ?? pin.media.images["600x"] ?? pin.media.images.originals;
          if (!imageInfo) {
            return {
              content: [{ type: "text" as const, text: `No image available in size "${selectedSize}". Available: ${Object.keys(pin.media.images).join(", ")}` }],
              isError: true,
            };
          }

          const { data, mimeType } = await fetchImageAsBase64(imageInfo.url);

          return {
            content: [
              { type: "image" as const, data, mimeType },
              {
                type: "text" as const,
                text: [
                  `Pin: ${pin.title ?? "(no title)"} [${pin.id}]`,
                  `Description: ${pin.description ?? "(none)"}`,
                  `Alt text: ${pin.alt_text ?? "(none)"}`,
                  `Board ID: ${pin.board_id}`,
                  `Section ID: ${pin.board_section_id ?? "(none)"}`,
                  `Link: ${pin.link ?? "(none)"}`,
                  `Image size: ${imageInfo.width}x${imageInfo.height}`,
                  `Type: ${pin.creative_type ?? "unknown"}`,
                ].join("\n"),
              },
            ],
          };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- update_pin ---
  if (canWrite) {
    server.tool(
      "update_pin",
      "Update a pin's title, description, alt text, link, or board placement.",
      {
        pin_id: z.string().describe("Pin ID"),
        title: z.string().max(100).optional().describe("New title (max 100 chars)"),
        description: z.string().max(800).optional().describe("New description (max 800 chars)"),
        alt_text: z.string().max(500).optional().describe("New alt text for accessibility (max 500 chars)"),
        link: z.string().optional().describe("New link URL"),
        board_id: z.string().optional().describe("Move to different board"),
        board_section_id: z.string().optional().describe("Move to different section"),
      },
      async ({ pin_id, title, description, alt_text, link, board_id, board_section_id }) => {
        try {
          const update: Record<string, string> = {};
          if (title !== undefined) update.title = title;
          if (description !== undefined) update.description = description;
          if (alt_text !== undefined) update.alt_text = alt_text;
          if (link !== undefined) update.link = link;
          if (board_id !== undefined) update.board_id = board_id;
          if (board_section_id !== undefined) update.board_section_id = board_section_id;

          if (Object.keys(update).length === 0) {
            return { content: [{ type: "text" as const, text: "No fields provided to update." }], isError: true };
          }

          const pin = await updatePin(pin_id, update);
          return { content: [{ type: "text" as const, text: `Pin updated successfully:\n${formatPinDetails(pin)}` }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- move_pin ---
  if (canWrite) {
    server.tool(
      "move_pin",
      "Move a pin to a different board and/or section.",
      {
        pin_id: z.string().describe("Pin ID"),
        board_id: z.string().describe("Target board ID"),
        section_id: z.string().optional().describe("Target section ID within the board"),
        skip_if_duplicate: z.boolean().optional().describe("If true, skip the move if an identical image already exists in the target (default false)"),
        duplicate_scope: z.enum(["board", "section_only"]).optional().describe("Scope for duplicate check when skip_if_duplicate is true: 'board' checks the entire board (default), 'section_only' checks only the target section"),
      },
      async ({ pin_id, board_id, section_id, skip_if_duplicate, duplicate_scope }) => {
        try {
          if (skip_if_duplicate) {
            const srcPin = await getPin(pin_id);
            const srcUrl = getBestImageUrl(srcPin);
            if (srcUrl) {
              const srcHash = await fetchImageHash(srcUrl);
              const checkSectionId = duplicate_scope === "section_only" ? section_id : undefined;
              const dup = await findDuplicateInBoard(srcHash, board_id, checkSectionId, pin_id);
              if (dup) {
                const scopeLabel = duplicate_scope === "section_only" ? "target section" : "target board";
                return {
                  content: [{ type: "text" as const, text: `Skipped: identical image already exists in ${scopeLabel}.\nExisting pin: [${dup.id}] "${dup.title ?? "(no title)"}"` }],
                };
              }
            }
          }
          const update: Record<string, string> = { board_id };
          if (section_id) update.board_section_id = section_id;

          const pin = await updatePin(pin_id, update);
          return {
            content: [{ type: "text" as const, text: `Pin moved to board ${pin.board_id}${pin.board_section_id ? ` / section ${pin.board_section_id}` : ""}.` }],
          };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );

    // --- move_pin_safe ---
    server.tool(
      "move_pin_safe",
      "Safely move a pin by saving it to the target location first, verifying the save succeeded, then deleting the original. Unlike move_pin (which uses a single PATCH), this guarantees the pin is never lost if the delete fails — it reports partial success so you can clean up manually.",
      {
        pin_id: z.string().describe("Pin ID to move"),
        board_id: z.string().describe("Target board ID"),
        section_id: z.string().optional().describe("Target section ID within the board"),
        skip_if_duplicate: z.boolean().optional().describe("If true, skip if an identical image already exists in the target (default false)"),
        duplicate_scope: z.enum(["board", "section_only"]).optional().describe("Scope for duplicate check: 'board' checks entire board (default), 'section_only' checks only the target section"),
      },
      async ({ pin_id, board_id, section_id, skip_if_duplicate, duplicate_scope }) => {
        try {
          if (skip_if_duplicate) {
            const srcPin = await getPin(pin_id);
            const srcUrl = getBestImageUrl(srcPin);
            if (srcUrl) {
              const srcHash = await fetchImageHash(srcUrl);
              const checkSectionId = duplicate_scope === "section_only" ? section_id : undefined;
              const dup = await findDuplicateInBoard(srcHash, board_id, checkSectionId, pin_id);
              if (dup) {
                const scopeLabel = duplicate_scope === "section_only" ? "target section" : "target board";
                return {
                  content: [{ type: "text" as const, text: `Skipped: identical image already exists in ${scopeLabel}.\nExisting pin: [${dup.id}] "${dup.title ?? "(no title)"}"` }],
                };
              }
            }
          }

          // Step 1: Save to target
          const newPin = await savePin(pin_id, board_id, section_id);

          // Step 2: Verify save
          let verified = false;
          try {
            const check = await getPin(newPin.id);
            verified = check.id === newPin.id && check.board_id === board_id;
          } catch {
            // verification fetch failed
          }

          if (!verified) {
            return {
              content: [{
                type: "text" as const,
                text: `Save appeared to succeed (new pin ${newPin.id}) but verification failed. Original pin ${pin_id} was NOT deleted. Check both pins manually.`,
              }],
              isError: true,
            };
          }

          // Step 3: Delete original
          try {
            await deletePin(pin_id);
          } catch (deleteErr) {
            const errMsg = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
            return {
              content: [{
                type: "text" as const,
                text: `Pin saved successfully as [${newPin.id}] in board ${board_id}${section_id ? ` / section ${section_id}` : ""}, but deletion of original [${pin_id}] failed: ${errMsg}\nThe pin now exists in both locations — delete [${pin_id}] manually.`,
              }],
              isError: true,
            };
          }

          return {
            content: [{
              type: "text" as const,
              text: `Pin moved safely.\n  Original [${pin_id}] deleted.\n  New ${formatPinDetails(newPin)}`,
            }],
          };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- delete_pin ---
  if (canWrite) {
    server.tool(
      "delete_pin",
      "Permanently delete a pin.",
      {
        pin_id: z.string().describe("Pin ID to delete"),
      },
      async ({ pin_id }) => {
        try {
          await deletePin(pin_id);
          return { content: [{ type: "text" as const, text: `Pin ${pin_id} deleted successfully.` }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- save_pin ---
  if (canWrite) {
    server.tool(
      "save_pin",
      "Save an existing pin to one of your boards.",
      {
        pin_id: z.string().describe("Pin ID to save"),
        board_id: z.string().describe("Target board ID"),
        board_section_id: z.string().optional().describe("Target section ID (optional)"),
        skip_if_duplicate: z.boolean().optional().describe("If true, skip saving if an identical image already exists in the target (default false)"),
        duplicate_scope: z.enum(["board", "section_only"]).optional().describe("Scope for duplicate check: 'board' checks entire board (default), 'section_only' checks only the target section"),
      },
      async ({ pin_id, board_id, board_section_id, skip_if_duplicate, duplicate_scope }) => {
        try {
          if (skip_if_duplicate) {
            const srcPin = await getPin(pin_id);
            const srcUrl = getBestImageUrl(srcPin);
            if (srcUrl) {
              const srcHash = await fetchImageHash(srcUrl);
              const checkSectionId = duplicate_scope === "section_only" ? board_section_id : undefined;
              const dup = await findDuplicateInBoard(srcHash, board_id, checkSectionId, pin_id);
              if (dup) {
                const scopeLabel = duplicate_scope === "section_only" ? "target section" : "target board";
                return {
                  content: [{ type: "text" as const, text: `Skipped: identical image already exists in ${scopeLabel}.\nExisting pin: [${dup.id}] "${dup.title ?? "(no title)"}"` }],
                };
              }
            }
          }
          const pin = await savePin(pin_id, board_id, board_section_id);
          return { content: [{ type: "text" as const, text: `Pin saved successfully:\n${formatPinDetails(pin)}` }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- create_pin ---
  if (canWrite) {
    server.tool(
      "create_pin",
      "Create a new pin from an image URL or base64-encoded image data.",
      {
        board_id: z.string().describe("Board ID to pin to"),
        image_url: z.string().optional().describe("Source image URL (use this OR image_base64)"),
        image_base64: z.string().optional().describe("Base64-encoded image data (use this OR image_url)"),
        content_type: z.string().optional().describe("MIME type for base64 image, e.g. image/jpeg (required with image_base64)"),
        title: z.string().max(100).optional().describe("Pin title (max 100 chars)"),
        description: z.string().max(800).optional().describe("Pin description (max 800 chars)"),
        alt_text: z.string().max(500).optional().describe("Alt text for accessibility (max 500 chars)"),
        link: z.string().optional().describe("Destination link URL"),
        board_section_id: z.string().optional().describe("Board section ID"),
        skip_if_duplicate: z.boolean().optional().describe("If true, skip creation if an identical image already exists in the target (default false)"),
        duplicate_scope: z.enum(["board", "section_only"]).optional().describe("Scope for duplicate check: 'board' checks entire board (default), 'section_only' checks only the target section"),
      },
      async ({ board_id, image_url, image_base64, content_type, title, description, alt_text, link, board_section_id, skip_if_duplicate, duplicate_scope }) => {
        try {
          if (!image_url && !image_base64) {
            return { content: [{ type: "text" as const, text: "Provide either image_url or image_base64." }], isError: true };
          }

          if (skip_if_duplicate) {
            const imageHash = image_base64
              ? createHash("sha256").update(Buffer.from(image_base64, "base64")).digest("hex")
              : await fetchImageHash(image_url!);
            const checkSectionId = duplicate_scope === "section_only" ? board_section_id : undefined;
            const dup = await findDuplicateInBoard(imageHash, board_id, checkSectionId);
            if (dup) {
              const scopeLabel = duplicate_scope === "section_only" ? "target section" : "target board";
              return {
                content: [{ type: "text" as const, text: `Skipped: identical image already exists in ${scopeLabel}.\nExisting pin: [${dup.id}] "${dup.title ?? "(no title)"}"` }],
              };
            }
          }

          const media_source = image_base64
            ? { source_type: "image_base64" as const, content_type: content_type ?? "image/jpeg", data: image_base64 }
            : { source_type: "image_url" as const, url: image_url! };

          const pin = await createPin({
            board_id,
            media_source,
            title,
            description,
            alt_text,
            link,
            board_section_id,
          });
          return { content: [{ type: "text" as const, text: `Pin created successfully:\n${formatPinDetails(pin)}` }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- get_top_pins ---
  if (scopes.has("user_accounts:read")) {
    server.tool(
      "get_top_pins",
      "Get your top performing pins ranked by a metric (engagement, impressions, clicks, saves).",
      {
        start_date: z.string().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().describe("End date (YYYY-MM-DD)"),
        sort_by: z
          .enum(["ENGAGEMENT", "IMPRESSION", "OUTBOUND_CLICK", "REPIN", "SAVE"])
          .describe("Metric to rank pins by"),
        num_of_pins: z.number().min(1).max(100).optional().describe("Number of top pins to return (1-100, default 10)"),
      },
      async ({ start_date, end_date, sort_by, num_of_pins }) => {
        try {
          const data: TopPinsAnalyticsResponse = await getUserTopPins(start_date, end_date, sort_by, num_of_pins ?? 10);

          if (!data.pins || data.pins.length === 0) {
            return { content: [{ type: "text" as const, text: "No top pins data available for the selected period." }] };
          }

          const lines: string[] = [`Top Pins by ${sort_by} — ${start_date} to ${end_date}:`];
          data.pins.forEach((item, i) => {
            const metrics = Object.entries(item)
              .filter(([k]) => k !== "pin_id")
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            lines.push(`  ${i + 1}. [${item.pin_id}] ${metrics}`);
          });

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- find_duplicate_pins ---
  if (canRead) {
    server.tool(
      "find_duplicate_pins",
      "Find pins on a board that contain the same image as a given pin. Compares by image hash (SHA-256). Useful to detect accidental duplicates before or after moving/copying pins.",
      {
        pin_id: z.string().describe("Reference pin ID to check duplicates of"),
        board_id: z.string().describe("Board ID to search in"),
        section_id: z.string().optional().describe("Limit search to a specific section (optional)"),
        max_pins: z.number().min(1).max(500).optional().describe("Max pins to scan (default 200). Larger boards take longer."),
      },
      async ({ pin_id, board_id, section_id, max_pins }) => {
        try {
          // 1. Get reference pin and its image URL
          const refPin = await getPin(pin_id);
          const refImages = refPin.media?.images;
          if (!refImages) {
            return { content: [{ type: "text" as const, text: "Reference pin has no image media." }], isError: true };
          }

          const refImageUrl =
            refImages.originals?.url ??
            refImages["1200x"]?.url ??
            refImages["600x"]?.url ??
            refImages["400x300"]?.url;

          if (!refImageUrl) {
            return { content: [{ type: "text" as const, text: "Could not find image URL for reference pin." }], isError: true };
          }

          const refHash = await fetchImageHash(refImageUrl);
          const limit = max_pins ?? 200;
          const duplicates: Pin[] = [];
          let scanned = 0;
          let bookmark: string | undefined;

          // 2. Paginate through board/section pins
          do {
            const page = section_id
              ? await listSectionPins(board_id, section_id, 100, bookmark ?? undefined)
              : await listBoardPins(board_id, 100, bookmark ?? undefined);

            for (const pin of page.items) {
              if (scanned >= limit) break;
              if (pin.id === pin_id) continue; // skip self

              const imgUrl =
                pin.media?.images?.originals?.url ??
                pin.media?.images?.["1200x"]?.url ??
                pin.media?.images?.["600x"]?.url;

              if (!imgUrl) continue;

              // Fast path: identical URL → definite duplicate
              if (imgUrl === refImageUrl) {
                duplicates.push(pin);
                scanned++;
                continue;
              }

              // Slow path: hash comparison for same content at different URL
              try {
                const hash = await fetchImageHash(imgUrl);
                if (hash === refHash) duplicates.push(pin);
              } catch {
                // ignore fetch errors for individual pins
              }
              scanned++;
            }

            bookmark = page.bookmark ?? undefined;
          } while (bookmark && scanned < limit);

          if (duplicates.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No duplicate images found (scanned ${scanned} pins).` }],
            };
          }

          const lines = [
            `Found ${duplicates.length} duplicate(s) among ${scanned} scanned pins:`,
            "",
            ...duplicates.map((p) =>
              `[${p.id}] "${p.title ?? "(no title)"}" — board: ${p.board_id}${p.board_section_id ? ` / section ${p.board_section_id}` : ""}`,
            ),
          ];

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- get_pin_analytics ---
  if (canRead) {
    server.tool(
      "get_pin_analytics",
      "Get analytics for a pin (impressions, clicks, saves, etc.).",
      {
        pin_id: z.string().describe("Pin ID"),
        start_date: z.string().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().describe("End date (YYYY-MM-DD)"),
        metric_types: z
          .array(z.enum(["IMPRESSION", "ENGAGEMENT", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE", "VIDEO_START", "VIDEO_10S_VIEW", "VIDEO_MRC_VIEW"]))
          .optional()
          .describe("Metrics to retrieve (default: all basic metrics)"),
      },
      async ({ pin_id, start_date, end_date, metric_types }) => {
        try {
          const metrics = metric_types ?? ["IMPRESSION", "ENGAGEMENT", "OUTBOUND_CLICK", "SAVE"];
          const data = await getPinAnalytics(pin_id, start_date, end_date, metrics);

          const lines: string[] = [`Pin Analytics [${pin_id}] — ${start_date} to ${end_date}:`];

          for (const [metric, value] of Object.entries(data)) {
            lines.push(`\n${metric}:`);
            if (value.summary_metrics && Object.keys(value.summary_metrics).length > 0) {
              lines.push(`  Summary:`);
              for (const [k, v] of Object.entries(value.summary_metrics)) {
                lines.push(`    ${k}: ${v}`);
              }
            }
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }
}
