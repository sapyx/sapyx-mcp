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
} from "../api.js";
import type { ImageSizeKey, Pin, TopPinsAnalyticsResponse } from "../types.js";
import { handleToolError } from "./utils.js";

/** Format a pin summary for listing */
function formatPinSummary(pin: Pin): string {
  const title = pin.title || "(no title)";
  const desc = pin.description
    ? pin.description.length > 80
      ? pin.description.substring(0, 80) + "…"
      : pin.description
    : "(no description)";
  const type = pin.creative_type ?? "unknown";
  return `[${pin.id}] "${title}" — ${desc} [${type}]`;
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
      },
      async ({ board_id, section_id, page_size, bookmark }) => {
        try {
          const result = section_id
            ? await listSectionPins(board_id, section_id, page_size, bookmark)
            : await listBoardPins(board_id, page_size, bookmark);

          if (result.items.length === 0) {
            return { content: [{ type: "text" as const, text: "No pins found." }] };
          }

          const lines = result.items.map(formatPinSummary);
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
      },
      async ({ pin_id, board_id, section_id }) => {
        try {
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
      },
      async ({ pin_id, board_id, board_section_id }) => {
        try {
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
      },
      async ({ board_id, image_url, image_base64, content_type, title, description, alt_text, link, board_section_id }) => {
        try {
          if (!image_url && !image_base64) {
            return { content: [{ type: "text" as const, text: "Provide either image_url or image_base64." }], isError: true };
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
