import { randomUUID } from "node:crypto";

const token = "[a-f0-9]{16}|host|unknown";
const generation = "[a-f0-9]{32}";

const leasePattern = new RegExp(
  `^lease-v1-p(\\d+)-n(${token})-g(${generation})$`,
);
const reapingPattern = new RegExp(
  `^\\.reaping-v1-p(\\d+)-n(${token})-o(\\d+)-g(${generation})-c(${generation})$`,
);

export interface LeaseName {
  kind: "lease";
  ownerPid: number;
  namespace: string;
  generation: string;
}

export interface ReapingName {
  kind: "reaping";
  reaperPid: number;
  ownerPid: number;
  namespace: string;
  generation: string;
}

export type OwnedName = LeaseName | ReapingName;

function validPid(value: string): number | undefined {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function generationToken(): string {
  return randomUUID().replaceAll("-", "");
}

export function leaseName(
  pid: number,
  namespace: string,
  generation = generationToken(),
): string {
  return `lease-v1-p${pid}-n${namespace}-g${generation}`;
}

export function reapingName(
  ownerPid: number,
  namespace: string,
  generation: string,
): string {
  return `.reaping-v1-p${process.pid}-n${namespace}-o${ownerPid}-g${generation}-c${generationToken()}`;
}

export function keptName(): string {
  return `kept-v1-g${generationToken()}`;
}

export function parseOwnedName(name: string): OwnedName | undefined {
  const lease = leasePattern.exec(name);
  if (lease) {
    const ownerPid = validPid(lease[1]!);
    if (ownerPid === undefined) return undefined;
    return {
      kind: "lease",
      ownerPid,
      namespace: lease[2]!,
      generation: lease[3]!,
    };
  }

  const reaping = reapingPattern.exec(name);
  if (!reaping) return undefined;
  const reaperPid = validPid(reaping[1]!);
  const ownerPid = validPid(reaping[3]!);
  if (reaperPid === undefined || ownerPid === undefined) return undefined;
  return {
    kind: "reaping",
    reaperPid,
    namespace: reaping[2]!,
    ownerPid,
    generation: reaping[4]!,
  };
}
