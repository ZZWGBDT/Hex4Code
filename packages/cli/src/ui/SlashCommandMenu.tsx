import {
  formatSlashCommandDescription,
  formatSlashCommandLabel,
} from "./slashCommands";
import type { SlashCommandItem } from "./slashCommands";
import React from "react";
import { Box, Text } from "ink";
import { CLI_THEME } from "./theme";

type SlashCommandMenuProps = {
  items: SlashCommandItem[];
  activeIndex: number;
  width: number;
  maxVisible?: number;
};

const SlashCommandMenu = React.memo(function SlashCommandMenu({
  items,
  activeIndex,
  maxVisible = 6,
  width,
}: SlashCommandMenuProps): React.ReactElement | null {
  // Calculate the optimal label column width: includes prefixes like "> " or "  " (2 chars), no more than half the container (minus gap)
  const labelColumnWidth = React.useMemo(() => {
    if (items.length === 0) {
      return 0;
    }
    const longestLabel = Math.max(...items.map((s) => s.label.length));
    const contentWidth = longestLabel + 2; // +2 for prefix "› " or "  "
    const maxAllowed = Math.max(10, (width - 2) >> 1); // 50% container width (minus gap), at least 10 columns
    return Math.min(contentWidth, maxAllowed);
  }, [items, width]);

  if (items.length === 0) {
    return null;
  }

  // Calculate visible window start position, ensuring activeIndex is always within the visible area
  const visibleStart = Math.min(
    Math.max(0, activeIndex - Math.floor((maxVisible - 1) / 2)),
    Math.max(0, items.length - maxVisible),
  );
  const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);

  return (
    <Box flexDirection="column" marginBottom={1} width={width}>
      {visibleStart > 0 ? (
        <Box marginLeft={2}>
          <Text dimColor>▲</Text>
        </Box>
      ) : null}
      {visibleItems.map((item, idx) => {
        const actualIndex = visibleStart + idx;
        return (
          <Box key={item.label} gap={2} flexDirection="row" flexGrow={1}>
            <Box width={labelColumnWidth} flexShrink={0}>
              <Text
                color={
                  actualIndex === activeIndex
                    ? CLI_THEME.accentStrong
                    : undefined
                }
                wrap="truncate-end"
              >
                {actualIndex === activeIndex ? "› " : "  "}
                <Text bold>{formatSlashCommandLabel(item)}</Text>
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text
                color={
                  actualIndex === activeIndex ? CLI_THEME.accent : undefined
                }
                wrap="truncate-end"
                dimColor
              >
                {formatSlashCommandDescription(item.description)}
              </Text>
            </Box>
          </Box>
        );
      })}
      <Box marginLeft={2} flexDirection="column">
        {visibleStart + visibleItems.length < items.length ? (
          <Text dimColor>▼</Text>
        ) : null}
        <Text dimColor>
          ({activeIndex + 1}/{items.length}) ↑↓ to navigate · Enter to select
        </Text>
      </Box>
    </Box>
  );
});

export default SlashCommandMenu;
