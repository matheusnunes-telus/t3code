import type { EnvironmentId, GcpEnvironment, GcpProjectLink, GcpRuntime } from "@t3tools/contracts";
import { LoaderIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { gcpLoginHealth, useGcpCommand, useGcpSnapshot } from "~/state/gcp";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

const RUNTIME_LABELS: Record<GcpRuntime, string> = {
  "cloud-run": "Cloud Run",
  gke: "GKE",
  other: "Other",
};

const EMPTY_ENVIRONMENT: GcpEnvironment = {
  name: "",
  projectId: "",
  region: null,
  runtime: "other",
  deployWorkflow: null,
};

export interface GcpProjectTarget {
  readonly key: string;
  readonly title: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly workspaceRoot: string;
}

/** A T3 project's Google Cloud environments and Terraform folders, in project settings. */
export function GcpProjectSection({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: GcpProjectTarget;
}) {
  const snapshot = useGcpSnapshot(environmentId);
  const command = useGcpCommand(environmentId);
  const [draft, setDraft] = useState<GcpProjectLink | null>(null);
  const [finding, setFinding] = useState(false);
  if (snapshot === null || gcpLoginHealth(snapshot) === "hidden") return null;
  const link = snapshot.links.find((entry) => entry.key === target.key) ?? null;

  const findProjects = async () => {
    setFinding(true);
    const result = await command({ type: "suggestLink", ...target });
    setFinding(false);
    setDraft(
      result !== null && result._tag === "Success" && result.value !== null
        ? result.value
        : { ...target, environments: [], terraformRepos: [] },
    );
  };

  return (
    <SettingsSection id="project-google-cloud" title="Google Cloud">
      {link === null ? (
        <SettingsRow
          title="Not linked"
          description="Link this project to its Google Cloud projects, one per environment, so chats know where it runs."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={finding}
              onClick={() => void findProjects()}
            >
              {finding ? <LoaderIcon className="animate-spin" /> : null}
              {finding ? "Looking…" : "Find Google Cloud projects"}
            </Button>
          }
        />
      ) : (
        <>
          {link.environments.map((environment) => (
            <SettingsRow
              key={`${environment.name}:${environment.projectId}`}
              title={
                <span className="flex items-center gap-2">
                  <Badge size="sm" variant="secondary">
                    {environment.name}
                  </Badge>
                  <span className="font-mono text-xs">{environment.projectId}</span>
                </span>
              }
              description={[
                RUNTIME_LABELS[environment.runtime],
                environment.region,
                environment.deployWorkflow ? `deploys with ${environment.deployWorkflow}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
          {link.terraformRepos.map((folder) => (
            <SettingsRow
              key={folder}
              title={
                <span className="flex items-center gap-2">
                  <Badge size="sm" variant="outline">
                    Terraform
                  </Badge>
                  <span className="font-mono text-xs">{folder}</span>
                </span>
              }
            />
          ))}
          <SettingsRow
            title={link.environments.length === 0 ? "No environments yet" : "Change the link"}
            control={
              <span className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setDraft(link)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  onClick={() => void command({ type: "removeLink", key: link.key })}
                >
                  Unlink
                </Button>
              </span>
            }
          />
        </>
      )}
      <GcpLinkDialog
        draft={draft}
        cloudProjectIds={snapshot.cloudProjects.map((project) => project.projectId)}
        onClose={() => setDraft(null)}
        onSave={(next) => {
          void command({ type: "saveLink", link: next });
          setDraft(null);
        }}
      />
    </SettingsSection>
  );
}

function GcpLinkDialog({
  draft,
  cloudProjectIds,
  onClose,
  onSave,
}: {
  draft: GcpProjectLink | null;
  cloudProjectIds: ReadonlyArray<string>;
  onClose: () => void;
  onSave: (link: GcpProjectLink) => void;
}) {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPopup className="max-w-2xl">
        {draft !== null ? (
          <GcpLinkForm
            key={draft.key}
            draft={draft}
            cloudProjectIds={cloudProjectIds}
            onClose={onClose}
            onSave={onSave}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function GcpLinkForm({
  draft,
  cloudProjectIds,
  onClose,
  onSave,
}: {
  draft: GcpProjectLink;
  cloudProjectIds: ReadonlyArray<string>;
  onClose: () => void;
  onSave: (link: GcpProjectLink) => void;
}) {
  const [environments, setEnvironments] = useState<ReadonlyArray<GcpEnvironment>>(
    draft.environments,
  );
  const [terraformRepos, setTerraformRepos] = useState<ReadonlyArray<string>>(draft.terraformRepos);
  const listId = `gcp-projects-${draft.key}`;
  const setEnvironment = (index: number, patch: Partial<GcpEnvironment>) =>
    setEnvironments((current) =>
      current.map((environment, at) => (at === index ? { ...environment, ...patch } : environment)),
    );
  const complete = environments.filter(
    (environment) => environment.name.trim().length > 0 && environment.projectId.trim().length > 0,
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Link {draft.title} to Google Cloud</DialogTitle>
        <DialogDescription>
          {draft.environments.length > 0
            ? "Found from your Google Cloud projects, this repo's deploy workflows and nearby Terraform. Check it before saving."
            : "Nothing matched this project's name. Add its environments by hand."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <datalist id={listId}>
          {cloudProjectIds.map((projectId) => (
            <option key={projectId} value={projectId} />
          ))}
        </datalist>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              Environments
            </p>
            {environments.map((environment, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- rows have no id until saved, and editing a name must not remount its row.
              <div key={index} className="flex flex-wrap items-center gap-1.5">
                <Input
                  size="sm"
                  className="w-24"
                  aria-label="Environment name"
                  placeholder="Name"
                  value={environment.name}
                  onChange={(event) => setEnvironment(index, { name: event.currentTarget.value })}
                />
                <Input
                  size="sm"
                  className="w-60"
                  aria-label="Google Cloud project id"
                  placeholder="project-id"
                  list={listId}
                  value={environment.projectId}
                  onChange={(event) =>
                    setEnvironment(index, { projectId: event.currentTarget.value.trim() })
                  }
                />
                <Input
                  size="sm"
                  className="w-52"
                  aria-label="Region"
                  placeholder="Region"
                  value={environment.region ?? ""}
                  onChange={(event) => {
                    const region = event.currentTarget.value.trim();
                    setEnvironment(index, { region: region.length > 0 ? region : null });
                  }}
                />
                <Select
                  value={environment.runtime}
                  onValueChange={(runtime) =>
                    setEnvironment(index, { runtime: (runtime ?? "other") as GcpRuntime })
                  }
                >
                  <SelectTrigger size="sm" className="w-28" aria-label="Runs on">
                    <SelectValue>{RUNTIME_LABELS[environment.runtime]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(Object.keys(RUNTIME_LABELS) as GcpRuntime[]).map((runtime) => (
                      <SelectItem key={runtime} hideIndicator value={runtime}>
                        {RUNTIME_LABELS[runtime]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Input
                  size="sm"
                  className="min-w-48 flex-1"
                  aria-label="Deploy workflow"
                  placeholder=".github/workflows/deploy.yml"
                  value={environment.deployWorkflow ?? ""}
                  onChange={(event) => {
                    const workflow = event.currentTarget.value.trim();
                    setEnvironment(index, {
                      deployWorkflow: workflow.length > 0 ? workflow : null,
                    });
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove environment"
                  onClick={() =>
                    setEnvironments((current) => current.filter((_, at) => at !== index))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setEnvironments((current) => [...current, EMPTY_ENVIRONMENT])}
            >
              <PlusIcon />
              Add environment
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              Terraform folders
            </p>
            {terraformRepos.map((folder, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- folder rows are edited in place.
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  className="flex-1"
                  aria-label="Terraform folder"
                  placeholder="/path/to/terraform"
                  value={folder}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setTerraformRepos((current) =>
                      current.map((entry, at) => (at === index ? next : entry)),
                    );
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove Terraform folder"
                  onClick={() =>
                    setTerraformRepos((current) => current.filter((_, at) => at !== index))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setTerraformRepos((current) => [...current, ""])}
            >
              <PlusIcon />
              Add Terraform folder
            </Button>
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={complete.length === 0}
          onClick={() =>
            onSave({
              ...draft,
              environments: complete.map((environment) => ({
                ...environment,
                name: environment.name.trim(),
              })),
              terraformRepos: terraformRepos
                .map((folder) => folder.trim())
                .filter((folder) => folder.length > 0),
            })
          }
        >
          Save link
        </Button>
      </DialogFooter>
    </>
  );
}
