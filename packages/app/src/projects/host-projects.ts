import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { type HostProjectListItem } from "@/projects/host-project-model";

export {
  canCreateWorkspaceForHostProject,
  canCreateWorktreeForProjectKind,
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  getHostProjectId,
  getWorktreeSupportForHostProject,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveHostProjectCandidate,
  resolveExactHostProjectCandidate,
  resolveEquivalentHostProjectCandidate,
  resolveInitialWorkspaceProject,
  resolveInitialWorktreeProject,
  resolveSelectedHostProject,
  type HostProjectListItem,
  type HostProjectRouteContext,
} from "@/projects/host-project-model";

export function useHostProjects(
  serverIds: string[],
  options: { includeBackground?: boolean } = {},
): HostProjectListItem[] {
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const includeBackground = options.includeBackground ?? showBackground;
  const workspaceStructure = useWorkspaceStructure(serverIds, { includeBackground });
  return workspaceStructure.projects;
}
