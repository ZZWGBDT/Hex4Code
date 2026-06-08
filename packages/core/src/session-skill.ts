import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import matter from "gray-matter";
import type { SkillInfo } from "./session-types";

/**
 * ── Skill management — pure function module ─────────────────────────
 *
 * Extracted from SessionManager; all functions are independently exported,
 * Requires projectRoot to be passed in explicitly.
 */

export function resolveSkillPath(skillPath: string, projectRoot: string): string {
  if (skillPath.startsWith("~/")) {
    return path.join(os.homedir(), skillPath.slice(2));
  }
  if (skillPath.startsWith("~\\")) {
    return path.join(os.homedir(), skillPath.slice(2));
  }
  if (skillPath.startsWith("./")) {
    return path.join(projectRoot, skillPath.slice(2));
  }
  if (skillPath.startsWith(".\\")) {
    return path.join(projectRoot, skillPath.slice(2));
  }
  if (path.isAbsolute(skillPath)) {
    return skillPath;
  }
  return path.join(os.homedir(), skillPath);
}

export function readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
  const fallbackSkill: SkillInfo = {
    name: fallbackName.replace(/_/g, "-"),
    path: displayPath,
    description: "",
  };

  try {
    const skillMd = fs.readFileSync(skillPath, "utf8");
    const parsed = matter(skillMd);
    return {
      name:
        typeof parsed.data.name === "string" && parsed.data.name.trim() ? parsed.data.name.trim() : fallbackSkill.name,
      path: displayPath,
      description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
    };
  } catch {
    return fallbackSkill;
  }
}

export function getSkillKey(skill: Pick<SkillInfo, "path">): string {
  return `path:${skill.path}`;
}

export function getSkillKeyByName(name: string): string {
  return `name:${name}`;
}

export function dedupeSkills(skills?: SkillInfo[]): SkillInfo[] | undefined {
  if (!skills || skills.length === 0) {
    return undefined;
  }

  const dedupedSkills = new Map<string, SkillInfo>();
  for (const skill of skills) {
    if (!skill?.name || !skill?.path) {
      continue;
    }
    const key = getSkillKey(skill);
    const existingSkill = dedupedSkills.get(key);
    dedupedSkills.set(key, {
      ...existingSkill,
      ...skill,
      description: skill.description ?? existingSkill?.description ?? "",
      isLoaded: Boolean(existingSkill?.isLoaded || skill.isLoaded),
    });
  }

  return Array.from(dedupedSkills.values());
}
