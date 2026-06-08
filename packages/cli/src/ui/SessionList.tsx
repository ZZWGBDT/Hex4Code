import React, { useState, useMemo, useEffect, useRef } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { SessionEntry } from "@hex4code/core/session";
import { CLI_THEME } from "./theme";

type ActionMode = "navigate" | "confirmDelete" | "renaming";

type Props = {
  sessions: SessionEntry[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  onDelete: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
};

const STATUS_MESSAGE_DURATION_MS = 2000;

export function SessionList({
  sessions,
  onSelect,
  onCancel,
  onDelete,
  onExport,
  onRename,
}: Props): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [actionMode, setActionMode] = useState<ActionMode>("navigate");
  const [confirmTargetId, setConfirmTargetId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { columns, rows } = useWindowSize();

  // Dynamically calculate the number of visible sessions based on terminal height
  const maxVisibleSessions = useMemo(() => {
    // Subtract space used by borders, header, footer, scroll indicator, etc.
    // Outer container height=rows-1, outer border 2 + header 1 + inner border 2 + footer 1 + scroll indicator 1 = 8
    const reservedLines = 8;
    const linesPerSession = 3; // height=2 + marginBottom=1
    const availableLines = Math.max(0, Math.min(rows, 30) - reservedLines);
    return Math.max(1, Math.floor(availableLines / linesPerSession));
  }, [rows]);

  // Ensure index stays within valid range
  const safeIndex = useMemo(() => {
    if (sessions.length === 0) return 0;
    return Math.max(0, Math.min(index, sessions.length - 1));
  }, [index, sessions.length]);

  // Calculate scroll offset to keep the selected item visible
  const scrollOffset = useMemo(() => {
    if (safeIndex < maxVisibleSessions) return 0;
    return safeIndex - maxVisibleSessions + 1;
  }, [safeIndex, maxVisibleSessions]);

  // Get the currently visible session list
  const visibleSessions = useMemo(() => {
    return sessions.slice(scrollOffset, scrollOffset + maxVisibleSessions);
  }, [sessions, scrollOffset, maxVisibleSessions]);

  // Auto-dismiss status messages after the configured duration
  useEffect(() => {
    if (statusMessage) {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(
        () => setStatusMessage(null),
        STATUS_MESSAGE_DURATION_MS,
      );
      return () => {
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      };
    }
  }, [statusMessage]);

  useInput((input, key) => {
    // ── Renaming mode ───────────────────────────────────────────
    if (actionMode === "renaming") {
      if (key.escape) {
        setActionMode("navigate");
        setRenamingId(null);
        setRenameValue("");
        return;
      }
      if (key.return) {
        const targetId = renamingId;
        const newName = renameValue.trim();
        if (targetId && newName) {
          onRename(targetId, newName);
          setStatusMessage(`✅ Renamed to "${newName.slice(0, 40)}"`);
        }
        setActionMode("navigate");
        setRenamingId(null);
        setRenameValue("");
        return;
      }
      if (key.backspace || key.delete) {
        setRenameValue((v) => v.slice(0, -1));
        return;
      }
      // Append printable characters (filter out control inputs)
      if (input && input.length > 0 && !key.ctrl && !key.meta) {
        setRenameValue((v) => v + input);
      }
      return;
    }

    // ── Confirm-delete mode ─────────────────────────────────────
    if (actionMode === "confirmDelete") {
      if (key.escape || input === "n" || input === "N") {
        setActionMode("navigate");
        setConfirmTargetId(null);
        return;
      }
      if (input === "y" || input === "Y") {
        const targetId = confirmTargetId;
        if (targetId) {
          onDelete(targetId);
          setStatusMessage("✅ Deleted");
        }
        setActionMode("navigate");
        setConfirmTargetId(null);
        return;
      }
      return; // Ignore all other keys in confirm mode
    }

    // ── Normal navigation mode ──────────────────────────────────
    if (key.escape || (key.ctrl && (input === "c" || input === "C"))) {
      onCancel();
      return;
    }
    if (sessions.length === 0) {
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(sessions.length - 1, i + 1));
      return;
    }
    if (key.pageUp) {
      setIndex((i) => Math.max(0, i - maxVisibleSessions));
      return;
    }
    if (key.pageDown) {
      setIndex((i) => Math.min(sessions.length - 1, i + maxVisibleSessions));
      return;
    }
    if (key.home) {
      setIndex(0);
      return;
    }
    if (key.end) {
      setIndex(sessions.length - 1);
      return;
    }
    if (key.return) {
      const session = sessions[safeIndex];
      if (session) {
        onSelect(session.id);
      }
      return;
    }
    if (input === "d" || input === "D") {
      const session = sessions[safeIndex];
      if (session) {
        setActionMode("confirmDelete");
        setConfirmTargetId(session.id);
      }
      return;
    }
    if (input === "e" || input === "E") {
      const session = sessions[safeIndex];
      if (session) {
        onExport(session.id);
        setStatusMessage("✅ Exported to project root");
      }
      return;
    }
    if (input === "r" || input === "R") {
      const session = sessions[safeIndex];
      if (session) {
        setActionMode("renaming");
        setRenamingId(session.id);
        setRenameValue(session.summary || "");
      }
      return;
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No previous sessions found.</Text>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={Math.max(20, columns - 6)}
      height={Math.max(5, Math.min(rows - 1, 30))}
      overflow="hidden"
      paddingX={1}
      marginTop={1}
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={CLI_THEME.border}
        flexGrow={1}
        overflow="hidden"
      >
        {/* Header row */}
        <Box paddingX={1}>
          <Text bold color={CLI_THEME.accentStrong}>
            Resume a session
          </Text>
          <Text bold color={CLI_THEME.accent}>
            {" "}
            ({sessions.length} total)
          </Text>
        </Box>
        {/* Session list */}
        <Box
          borderTop={true}
          borderBottom={true}
          borderLeft={false}
          borderRight={false}
          borderStyle="round"
          borderColor={CLI_THEME.borderSoft}
          flexDirection="column"
          flexGrow={1}
          paddingX={1}
          overflow="hidden"
        >
          {visibleSessions.map((session, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === safeIndex;
            const isConfirmTarget =
              actionMode === "confirmDelete" && session.id === confirmTargetId;
            const isRenaming =
              actionMode === "renaming" && session.id === renamingId;

            return (
              <Box key={session.id} height={2} marginBottom={1}>
                <Box>
                  <Text
                    color={
                      isConfirmTarget
                        ? "red"
                        : isRenaming
                          ? CLI_THEME.accent
                          : CLI_THEME.accent
                    }
                  >
                    {isSelected ? "› " : "  "}
                  </Text>
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                  {isConfirmTarget ? (
                    <Box width={"100%"}>
                      <Text bold color="red">
                        Delete "
                        {formatSessionTitle(session.summary || "Untitled", 50)}
                        "? [y/N]
                      </Text>
                    </Box>
                  ) : isRenaming ? (
                    <Box width={"100%"}>
                      <Text bold color={CLI_THEME.accent}>
                        Rename: ▍{renameValue}
                      </Text>
                      <Text color={CLI_THEME.accent}>_</Text>
                    </Box>
                  ) : (
                    <Box width={"100%"}>
                      <Text
                        {...(isSelected ? { bold: true } : {})}
                        color={isSelected ? CLI_THEME.accentStrong : undefined}
                      >
                        {formatSessionTitle(session.summary || "Untitled")}
                      </Text>
                      <Text dimColor> ({session.status})</Text>
                    </Box>
                  )}
                  <Box width="100%">
                    <Text dimColor>{formatTimestamp(session.updateTime)} </Text>
                  </Box>
                </Box>
              </Box>
            );
          })}
          {scrollOffset > 0 ||
          scrollOffset + maxVisibleSessions < sessions.length ? (
            <Box marginTop={1}>
              {scrollOffset > 0 ? (
                <Text dimColor>… {scrollOffset} newer sessions above. </Text>
              ) : null}
              {scrollOffset + maxVisibleSessions < sessions.length ? (
                <Text dimColor>
                  … {sessions.length - scrollOffset - maxVisibleSessions} older
                  sessions below.
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
        {/* Footer */}
        <Box flexDirection="column">
          {statusMessage ? (
            <Box paddingX={1}>
              <Text color="green">{statusMessage}</Text>
            </Box>
          ) : null}
          <Box>
            <Text dimColor>
              {actionMode === "confirmDelete"
                ? "y confirm · n/esc cancel"
                : actionMode === "renaming"
                  ? "Type to edit · Enter save · Esc cancel"
                  : "↑/↓ navigate · PgUp/PgDn page · Enter select · D delete · E export · R rename · Esc cancel"}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function formatTimestamp(value: string): string {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
      return value;
    }
    return date.toLocaleString();
  } catch {
    return value;
  }
}

export function formatSessionTitle(value: string, max = 70): string {
  return truncate(
    value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim(),
    max,
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}
