// ============================================================
// MCP Tools — Pinterest Boards
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  listBoardSections,
  createBoardSection,
  updateBoardSection,
  deleteBoardSection,
} from "../api.js";
import { handleToolError } from "./utils.js";

export function registerBoardTools(server: McpServer, scopes: Set<string>): void {
  const canRead = scopes.has("boards:read") || scopes.has("boards:read_secret");
  const canWrite = scopes.has("boards:write") || scopes.has("boards:write_secret");

  // --- list_boards ---
  if (canRead) {
    server.tool(
      "list_boards",
      "List all boards for the authenticated Pinterest user.",
      {
        page_size: z.number().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        bookmark: z.string().optional().describe("Pagination cursor from previous response"),
      },
      async ({ page_size, bookmark }) => {
        try {
          const result = await listBoards(page_size, bookmark);

          if (result.items.length === 0) {
            return { content: [{ type: "text" as const, text: "No boards found." }] };
          }

          const lines = result.items.map((b) =>
            `[${b.id}] ${b.name} (${b.privacy}) — ${b.pin_count} pins`,
          );
          if (result.bookmark) lines.push(`\n--- More results. bookmark: "${result.bookmark}" ---`);

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- get_board ---
  if (canRead) {
    server.tool(
      "get_board",
      "Get full details of a specific Pinterest board.",
      {
        board_id: z.string().describe("Board ID"),
      },
      async ({ board_id }) => {
        try {
          const b = await getBoard(board_id);
          const text = [
            `Board Details:`,
            `  ID: ${b.id}`,
            `  Name: ${b.name}`,
            `  Privacy: ${b.privacy}`,
            `  Pins: ${b.pin_count}`,
            `  Followers: ${b.follower_count}`,
            b.description ? `  Description: ${b.description}` : "",
            `  Created: ${b.created_at}`,
            `  Owner: ${b.owner.username}`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text" as const, text }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- create_board ---
  if (canWrite) {
    server.tool(
      "create_board",
      "Create a new Pinterest board.",
      {
        name: z.string().describe("Board name"),
        description: z.string().optional().describe("Board description"),
        privacy: z.enum(["PUBLIC", "SECRET"]).optional().describe("Board privacy (default PUBLIC)"),
      },
      async ({ name, description, privacy }) => {
        try {
          const b = await createBoard(name, description, privacy);
          const text = [
            "Board created successfully:",
            `  ID: ${b.id}`,
            `  Name: ${b.name}`,
            `  Privacy: ${b.privacy}`,
            b.description ? `  Description: ${b.description}` : "",
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text" as const, text }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- update_board ---
  if (canWrite) {
    server.tool(
      "update_board",
      "Update a board's name, description, or privacy.",
      {
        board_id: z.string().describe("Board ID"),
        name: z.string().optional().describe("New board name"),
        description: z.string().optional().describe("New description"),
        privacy: z.enum(["PUBLIC", "SECRET"]).optional().describe("New privacy setting"),
      },
      async ({ board_id, name, description, privacy }) => {
        try {
          const update: Record<string, string> = {};
          if (name !== undefined) update.name = name;
          if (description !== undefined) update.description = description;
          if (privacy !== undefined) update.privacy = privacy;

          if (Object.keys(update).length === 0) {
            return { content: [{ type: "text" as const, text: "No fields provided to update." }], isError: true };
          }

          const b = await updateBoard(board_id, update);
          return {
            content: [{ type: "text" as const, text: `Board updated:\n  ID: ${b.id}\n  Name: ${b.name}\n  Privacy: ${b.privacy}` }],
          };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- delete_board ---
  if (canWrite) {
    server.tool(
      "delete_board",
      "Permanently delete a Pinterest board and all its pins.",
      {
        board_id: z.string().describe("Board ID to delete"),
      },
      async ({ board_id }) => {
        try {
          await deleteBoard(board_id);
          return { content: [{ type: "text" as const, text: `Board ${board_id} deleted successfully.` }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- list_board_sections ---
  if (canRead) {
    server.tool(
      "list_board_sections",
      "List all sections of a Pinterest board.",
      {
        board_id: z.string().describe("Board ID"),
        page_size: z.number().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        bookmark: z.string().optional().describe("Pagination cursor from previous response"),
      },
      async ({ board_id, page_size, bookmark }) => {
        try {
          const result = await listBoardSections(board_id, page_size, bookmark);

          if (result.items.length === 0) {
            return { content: [{ type: "text" as const, text: "No sections found in this board." }] };
          }

          const lines = result.items.map((s) => `[${s.id}] ${s.name}`);
          if (result.bookmark) lines.push(`\n--- More results. bookmark: "${result.bookmark}" ---`);

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- create_board_section ---
  if (canWrite) {
    server.tool(
      "create_board_section",
      "Create a new section in a Pinterest board.",
      {
        board_id: z.string().describe("Board ID"),
        name: z.string().describe("Section name"),
      },
      async ({ board_id, name }) => {
        try {
          const section = await createBoardSection(board_id, name);
          return {
            content: [{ type: "text" as const, text: `Section created:\n  ID: ${section.id}\n  Name: ${section.name}` }],
          };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- update_board_section ---
  if (canWrite) {
    server.tool(
      "update_board_section",
      "Rename a section within a Pinterest board.",
      {
        board_id: z.string().describe("Board ID"),
        section_id: z.string().describe("Section ID"),
        name: z.string().describe("New section name"),
      },
      async ({ board_id, section_id, name }) => {
        try {
          const section = await updateBoardSection(board_id, section_id, name);
          return {
            content: [{ type: "text" as const, text: `Section updated:\n  ID: ${section.id}\n  Name: ${section.name}` }],
          };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  // --- delete_board_section ---
  if (canWrite) {
    server.tool(
      "delete_board_section",
      "Delete a section from a Pinterest board.",
      {
        board_id: z.string().describe("Board ID"),
        section_id: z.string().describe("Section ID to delete"),
      },
      async ({ board_id, section_id }) => {
        try {
          await deleteBoardSection(board_id, section_id);
          return { content: [{ type: "text" as const, text: `Section ${section_id} deleted successfully.` }] };
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }
}
