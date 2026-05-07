param(
  [Parameter(Mandatory=$true)][string]$ShortcutPath,
  [Parameter(Mandatory=$true)][string]$TargetPath,
  [Parameter(Mandatory=$true)][string]$AppId,
  [string]$Arguments = "",
  [string]$WorkingDirectory = "",
  [string]$IconLocation = ""
)

# Creates a Start Menu shortcut whose IPropertyStore carries
# PKEY_AppUserModel_ID = $AppId. Without that property set, Windows toasts
# emitted by an unpackaged Electron build with the same AUMID never route
# their activation back to the running process — toast clicks become silent
# no-ops. The NSIS installer plants this shortcut for packaged builds; in
# `pnpm dev` we plant it ourselves on app startup.

$ErrorActionPreference = 'Stop'

# Inline C# COM interop for IShellLinkW + IPersistFile + IPropertyStore.
# Using the same instance for all three interfaces means we get one COM
# object created via Activator, then QueryInterface to each.
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LumiaDevShortcut {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    [ComImport]
    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint c);
        [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
        [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
        [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
        [PreserveSig] int Commit();
    }

    [ComImport]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out uint piShowCmd);
        void SetShowCmd(uint iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport]
    [Guid("0000010b-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([Out, MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    public static class Helper {
        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PROPVARIANT pvar);

        // ShellLink CLSID. Use Type.GetTypeFromCLSID + Activator.CreateInstance
        // so we don't need to register a CoClass type at compile time.
        public static readonly Guid CLSID_ShellLink =
            new Guid("00021401-0000-0000-c000-000000000046");

        // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5.
        public static PROPERTYKEY PKEY_AppUserModel_ID = new PROPERTYKEY {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5
        };

        public static void CreateLink(string linkPath, string targetPath, string args, string workingDir, string iconLoc, string appId) {
            Type t = Type.GetTypeFromCLSID(CLSID_ShellLink);
            object o = Activator.CreateInstance(t);
            try {
                IShellLinkW link = (IShellLinkW)o;
                link.SetPath(targetPath);
                if (!string.IsNullOrEmpty(args)) link.SetArguments(args);
                if (!string.IsNullOrEmpty(workingDir)) link.SetWorkingDirectory(workingDir);
                if (!string.IsNullOrEmpty(iconLoc)) link.SetIconLocation(iconLoc, 0);

                IPropertyStore props = (IPropertyStore)o;
                PROPVARIANT pv = new PROPVARIANT {
                    vt = 31, // VT_LPWSTR
                    pwszVal = Marshal.StringToCoTaskMemUni(appId)
                };
                try {
                    int hr = props.SetValue(ref PKEY_AppUserModel_ID, ref pv);
                    if (hr < 0) throw Marshal.GetExceptionForHR(hr);
                    hr = props.Commit();
                    if (hr < 0) throw Marshal.GetExceptionForHR(hr);
                } finally {
                    PropVariantClear(ref pv);
                }

                IPersistFile pf = (IPersistFile)o;
                pf.Save(linkPath, true);
            } finally {
                Marshal.ReleaseComObject(o);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

# Make sure the Start Menu Programs folder exists (it always does on a real
# Windows install, but a freshly-imaged dev box might not have it yet).
$dir = [System.IO.Path]::GetDirectoryName($ShortcutPath)
if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

[LumiaDevShortcut.Helper]::CreateLink($ShortcutPath, $TargetPath, $Arguments, $WorkingDirectory, $IconLocation, $AppId)
Write-Output ("Shortcut created: " + $ShortcutPath)
