import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode } from "react";
import { textDirection } from "~/textDirection";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { SearchMatchHintLine, ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string; isActionsOnly: boolean }) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {props.emptyStateMessage ??
        (props.isActionsOnly
          ? "No matching actions."
          : "No matching commands, projects, or threads.")}
    </div>
  );
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function CommandPaletteTitleIcon(props: { children: ReactNode }) {
  return <span className="flex h-5 shrink-0 items-center self-start pt-0.5">{props.children}</span>;
}

function CommandPaletteTitle({
  item,
}: {
  item: Pick<CommandPaletteActionItem | CommandPaletteSubmenuItem, "title">;
}) {
  const { title } = item;
  return (
    <span className="truncate" dir={typeof title === "string" ? textDirection(title) : undefined}>
      {title}
    </span>
  );
}

/**
 * Project and environment for a thread row whose second line shows a message
 * snippet or match hint instead, so similar rows can still be told apart.
 */
function ThreadRowContext({
  item,
}: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  if (!item.threadSearch || !(item.threadContentMatch || item.matchHint)) return null;
  // A "Project: …" hint already names the project.
  const context = [item.threadSearch.projectTitle, item.threadSearch.environmentLabel]
    .filter((part) => part && part !== item.matchHint?.text)
    .join(" · ");
  return context ? (
    <span className="max-w-[45%] shrink-0 truncate text-muted-foreground/70 text-xs">
      {context}
    </span>
  ) : null;
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      <CommandPaletteTitleIcon>{props.item.icon}</CommandPaletteTitleIcon>
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <CommandPaletteTitle item={props.item} />
            <ThreadRowContext item={props.item} />
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : props.item.matchHint ? (
            <SearchMatchHintLine hint={props.item.matchHint} />
          ) : props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <CommandPaletteTitle item={props.item} />
        </span>
      )}
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteTitleIcon>{props.item.icon}</CommandPaletteTitleIcon>
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <CommandPaletteTitle item={props.item} />
            <ThreadRowContext item={props.item} />
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : props.item.matchHint ? (
            <SearchMatchHintLine hint={props.item.matchHint} />
          ) : props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <CommandPaletteTitle item={props.item} />
        </span>
      )}
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
      ) : null}
    </CommandItem>
  );
}
