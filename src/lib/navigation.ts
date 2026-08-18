import {
  BookAIcon,
  HistoryIcon,
  LanguagesIcon,
  FileBarChartIcon,
  LayoutDashboardIcon,
  SearchIcon,
  Settings2Icon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import type { AppView } from "@/lib/app-types";
import { APP_NAME } from "@/lib/app-meta";

export type GameNavigationId = "civ7" | "legend";

export type NavigationItem = {
  id: AppView;
  label: string;
  icon: LucideIcon;
};

export type GameNavigationGroup = {
  id: GameNavigationId;
  label: string;
  productLabel: string;
  items: readonly NavigationItem[];
};

export const GAME_NAVIGATION = [
  {
    id: "civ7",
    label: "Sid Meier's Civilization VII",
    productLabel: "Sid Meier's Civilization VII",
    items: [
      { id: "dashboard", label: "Tổng quan", icon: LayoutDashboardIcon },
      { id: "pipeline", label: "Pipeline", icon: WorkflowIcon },
      { id: "reports", label: "Báo cáo", icon: FileBarChartIcon },
      { id: "search", label: "Tra cứu", icon: SearchIcon },
      { id: "glossary", label: "Glossary", icon: BookAIcon },
      { id: "settings", label: "Cài đặt", icon: Settings2Icon },
    ],
  },
  {
    id: "legend",
    label: "Legend of Heroes Three Kingdoms",
    productLabel: "Legend of Heroes Three Kingdoms",
    items: [
      { id: "legend-three-kingdoms", label: "Dịch", icon: LanguagesIcon },
      { id: "legend-search", label: "Tra cứu", icon: SearchIcon },
      { id: "legend-glossary", label: "Glossary", icon: BookAIcon },
      { id: "legend-history", label: "Lịch sử & hoàn tác", icon: HistoryIcon },
      { id: "legend-settings", label: "Cài đặt", icon: Settings2Icon },
    ],
  },
] as const satisfies readonly GameNavigationGroup[];

export const VIEW_LABELS: Record<AppView, string> = {
  dashboard: "Tổng quan",
  pipeline: "Pipeline",
  reports: "Báo cáo",
  search: "Tra cứu",
  glossary: "Glossary",
  settings: "Cài đặt",
  "legend-three-kingdoms": "Dịch",
  "legend-search": "Tra cứu",
  "legend-glossary": "Glossary",
  "legend-history": "Lịch sử & hoàn tác",
  "legend-settings": "Cài đặt",
  help: "Hướng dẫn",
  about: "Giới thiệu",
  "app-settings": "Cài đặt ứng dụng",
};

export function getGameNavigationGroup(view: AppView) {
  return GAME_NAVIGATION.find((group) =>
    group.items.some((item) => item.id === view),
  );
}

export function isCiv7View(view: AppView) {
  return getGameNavigationGroup(view)?.id === "civ7";
}

export function shouldAutoOpenSetup(view: AppView, setupComplete: boolean) {
  return isCiv7View(view) && !setupComplete;
}

export function getProductLabel(view: AppView) {
  return getGameNavigationGroup(view)?.productLabel ?? APP_NAME;
}
