export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export type WindowsAclCommand = (command: string, arguments_: readonly string[]) => void;

export type ManagedPaths = Readonly<{
  configDirectory: string;
  configFilePath: string;
  dataDirectory: string;
  cacheDirectory: string;
  backupDirectory: string;
}>;

export type ResolveManagedPathsInput = Readonly<{
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: EnvironmentMap;
  packageName?: string;
}>;

export const WINDOWS_ACL_SCRIPT = [
  "param([string]$path, [string]$kind)",
  "$isDirectory = $kind -eq 'directory'",
  "$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = if ($isDirectory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }",
  "$inheritance = if ($isDirectory) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$acl.SetOwner($owner)",
  "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($owner, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)))",
  "if ($isDirectory) { [System.IO.Directory]::SetAccessControl($path, $acl) } else { [System.IO.File]::SetAccessControl($path, $acl) }",
].join("; ");
