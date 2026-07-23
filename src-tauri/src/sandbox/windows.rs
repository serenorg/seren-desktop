// ABOUTME: Implements the verified Windows restricted-token sandbox launcher.
// ABOUTME: A suspended child is assigned to a kill-on-close Job Object before it runs.

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process;
    use std::slice;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use windows::Win32::Foundation::{
        CloseHandle, GENERIC_ALL, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL, LUID,
        LocalFree, SetHandleInformation, WAIT_FAILED, WAIT_OBJECT_0,
    };
    use windows::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, SE_FILE_OBJECT, SET_ACCESS,
        SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows::Win32::Security::{
        ACL, AdjustTokenPrivileges, AllocateAndInitializeSid, CopySid, CreateRestrictedToken,
        CreateWellKnownSid, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, FreeSid,
        GetLengthSid, GetTokenInformation, LUA_TOKEN, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
        PSECURITY_DESCRIPTOR, PSID, SE_PRIVILEGE_ENABLED, SECURITY_NT_AUTHORITY,
        SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT, SetTokenInformation,
        TOKEN_ACCESS_MASK, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_PRIVILEGES,
        TOKEN_QUERY, TokenDefaultDacl, TokenGroups, WRITE_RESTRICTED, WinWorldSid,
    };
    use windows::Win32::Storage::FileSystem::{
        DELETE, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    use windows::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows::Win32::System::Threading::{
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, GetCurrentProcess,
        GetExitCodeProcess, INFINITE, OpenProcessToken, PROCESS_CREATION_FLAGS,
        PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOW, WaitForSingleObject,
    };
    use windows::core::{PCWSTR, PWSTR};

    use super::super::policy::{SandboxError, SandboxMode, SandboxPolicy};

    const SANDBOX_LAUNCHER_ARGUMENT: &str = "__seren-sandbox-run";
    const BAD_ARGUMENTS_EXIT: i32 = 64;
    const BAD_POLICY_EXIT: i32 = 65;
    const ENFORCEMENT_FAILURE_EXIT: i32 = 69;
    const WRITE_CAPABILITY_MASK: u32 = FILE_GENERIC_READ.0
        | FILE_GENERIC_WRITE.0
        | FILE_GENERIC_EXECUTE.0
        | DELETE.0
        | FILE_DELETE_CHILD.0;
    const READ_CAPABILITY_MASK: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;

    struct HandleGuard(HANDLE);

    impl HandleGuard {
        fn new(handle: HANDLE) -> Self {
            Self(handle)
        }

        fn get(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    struct OwnedSid {
        sid: PSID,
    }

    impl OwnedSid {
        fn as_psid(&self) -> PSID {
            self.sid
        }
    }

    impl Drop for OwnedSid {
        fn drop(&mut self) {
            if !self.sid.is_invalid() {
                unsafe {
                    let _ = FreeSid(self.sid);
                }
            }
        }
    }

    struct SidBytes(Vec<u8>);

    impl SidBytes {
        fn as_psid(&self) -> PSID {
            PSID(self.0.as_ptr() as *mut _)
        }
    }

    struct AclSnapshot {
        path: PathBuf,
        dacl: Option<Vec<u8>>,
    }

    impl Drop for AclSnapshot {
        fn drop(&mut self) {
            let wide_path = wide(&self.path.to_string_lossy());
            let dacl = self.dacl.as_ref().map(|acl| acl.as_ptr() as *const ACL);
            let result = unsafe {
                SetNamedSecurityInfoW(
                    PCWSTR(wide_path.as_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    dacl,
                    None,
                )
            };
            if result.0 != 0 {
                eprintln!(
                    "Seren Windows sandbox: failed to restore DACL for {}: {}",
                    self.path.display(),
                    result.0
                );
            }
        }
    }

    pub fn apply_and_spawn_contained(
        policy: &SandboxPolicy,
        command: &str,
        args: &[String],
    ) -> Result<i32, SandboxError> {
        validate_policy(policy, command)?;

        // ACL changes are scoped to the lifetime of this launcher. This preserves the user's
        // original DACLs while the capability SID is active and still lets newly-created
        // descendants inherit the write grant during the child run.
        let mut acl_snapshots = Vec::new();
        let capability = capability_sid(policy)?;
        for root in &policy.workspace_roots {
            let snapshot = capture_acl(root)?;
            acl_snapshots.push(snapshot);
            let permissions = if policy.mode == SandboxMode::WorkspaceWrite {
                WRITE_CAPABILITY_MASK
            } else {
                READ_CAPABILITY_MASK
            };
            add_acl_entry(root, capability.as_psid(), permissions, SET_ACCESS)?;
        }

        let token = create_restricted_token(capability.as_psid())?;
        let job = create_job()?;
        let (application_name, mut command_line) = command_line(command, args);
        let application_wide = wide(&application_name);
        let current_directory_value = policy
            .workspace_roots
            .first()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        let current_directory = wide(&current_directory_value);
        let mut startup = startup_info();
        let inherit_handles = configure_stdio(&mut startup);
        let mut process_info = PROCESS_INFORMATION::default();
        let creation_flags: PROCESS_CREATION_FLAGS = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;

        unsafe {
            CreateProcessAsUserW(
                Some(token.get()),
                PCWSTR(application_wide.as_ptr()),
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                inherit_handles,
                creation_flags,
                None,
                PCWSTR(current_directory.as_ptr()),
                &startup,
                &mut process_info,
            )
            .map_err(|error| {
                SandboxError::Windows(format!("CreateProcessAsUserW failed: {error}"))
            })?;
        }

        let child_process = HandleGuard::new(process_info.hProcess);
        let child_thread = HandleGuard::new(process_info.hThread);

        unsafe {
            AssignProcessToJobObject(job.get(), child_process.get()).map_err(|error| {
                SandboxError::Windows(format!("AssignProcessToJobObject failed: {error}"))
            })?;

            if ResumeThread(child_thread.get()) == u32::MAX {
                return Err(SandboxError::Windows(format!(
                    "ResumeThread failed: {:?}",
                    windows::Win32::Foundation::GetLastError()
                )));
            }

            let wait_result = WaitForSingleObject(child_process.get(), INFINITE);
            if wait_result == WAIT_FAILED {
                return Err(SandboxError::Windows(format!(
                    "WaitForSingleObject failed: {:?}",
                    windows::Win32::Foundation::GetLastError()
                )));
            }
            if wait_result != WAIT_OBJECT_0 {
                return Err(SandboxError::Windows(format!(
                    "unexpected child wait result: {:?}",
                    wait_result
                )));
            }

            let mut exit_code = 0u32;
            GetExitCodeProcess(child_process.get(), &mut exit_code).map_err(|error| {
                SandboxError::Windows(format!("GetExitCodeProcess failed: {error}"))
            })?;
            Ok(exit_code as i32)
        }
    }

    pub fn sandbox_run_main(args: Vec<String>) -> ! {
        let rest = args.into_iter().skip(1).collect::<Vec<_>>();
        if rest.len() < 4
            || rest[0] != SANDBOX_LAUNCHER_ARGUMENT
            || rest[2] != "--"
            || rest[3].trim().is_empty()
        {
            exit_with(
                BAD_ARGUMENTS_EXIT,
                "usage: __seren-sandbox-run <base64-policy-json> -- <command> [args...]",
            );
        }

        let policy = match decode_policy(&rest[1]) {
            Ok(policy) => policy,
            Err(error) => exit_with(BAD_POLICY_EXIT, error),
        };
        if let Some(workspace_root) = policy.workspace_roots.first()
            && let Err(error) = std::env::set_current_dir(workspace_root)
        {
            exit_with(ENFORCEMENT_FAILURE_EXIT, error);
        }

        match apply_and_spawn_contained(&policy, &rest[3], &rest[4..]) {
            Ok(exit_code) => process::exit(exit_code),
            Err(error) => exit_with(ENFORCEMENT_FAILURE_EXIT, error),
        }
    }

    fn validate_policy(policy: &SandboxPolicy, command: &str) -> Result<(), SandboxError> {
        if policy.mode == SandboxMode::FullAccess {
            return Err(SandboxError::FullAccessNoProfile);
        }
        if policy.workspace_roots.is_empty() {
            return Err(SandboxError::EmptyWorkspaceRoots);
        }
        if command.trim().is_empty() {
            return Err(SandboxError::EmptyCommand);
        }
        if !policy.network_enabled {
            return Err(SandboxError::BackendUnavailable);
        }
        if !policy.deny_read.is_empty() {
            return Err(SandboxError::Windows(
                "the verified restricted-token backend cannot enforce deny-read paths; refusing to run unsandboxed"
                    .to_string(),
            ));
        }
        Ok(())
    }

    fn capability_sid(policy: &SandboxPolicy) -> Result<OwnedSid, SandboxError> {
        let mut hashes = [0x811c9dc5u32, 0x9e3779b9u32, 0x85ebca6bu32, 0xc2b2ae35u32];
        let seed = format!("{:?}\0{}", policy.mode, policy.workspace_roots[0].display());
        for byte in seed.as_bytes() {
            for (index, hash) in hashes.iter_mut().enumerate() {
                *hash ^= u32::from(*byte) + index as u32;
                *hash = hash.wrapping_mul(0x01000193);
            }
        }

        let mut sid = PSID::default();
        unsafe {
            // Use a synthetic NT-authority SID (S-1-5-21-...) as the restricting
            // capability, matching the pinned Codex restricted-token backend.
            // App-package capability SIDs (S-1-15-3-...) are rejected by
            // CreateRestrictedToken with WRITE_RESTRICTED on windows-latest. #3219.
            AllocateAndInitializeSid(
                &SECURITY_NT_AUTHORITY,
                5,
                21,
                hashes[0],
                hashes[1],
                hashes[2],
                hashes[3],
                0,
                0,
                0,
                &mut sid,
            )
            .map_err(|error| {
                SandboxError::Windows(format!("AllocateAndInitializeSid failed: {error}"))
            })?;
        }
        Ok(OwnedSid { sid })
    }

    fn create_restricted_token(capability: PSID) -> Result<HandleGuard, SandboxError> {
        let desired_access = TOKEN_ACCESS_MASK(
            TOKEN_DUPLICATE.0
                | TOKEN_QUERY.0
                | TOKEN_ASSIGN_PRIMARY.0
                | TOKEN_ADJUST_DEFAULT.0
                | TOKEN_ADJUST_SESSIONID.0
                | TOKEN_ADJUST_PRIVILEGES.0,
        );
        let mut base_token = HANDLE::default();
        unsafe {
            OpenProcessToken(GetCurrentProcess(), desired_access, &mut base_token).map_err(
                |error| SandboxError::Windows(format!("OpenProcessToken failed: {error}")),
            )?;
        }
        let base_token = HandleGuard::new(base_token);
        let logon_sid = logon_sid(base_token.get())?;
        let world_sid = world_sid()?;
        let restricted = [
            SID_AND_ATTRIBUTES {
                Sid: capability,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: logon_sid.as_psid(),
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: world_sid.as_psid(),
                Attributes: 0,
            },
        ];
        // This is the exact valid combination used by the pinned Codex
        // backend. CreateRestrictedToken accepts the three flags together;
        // the failure fixed by #3219 was the invalid app-package-style
        // restricting SID, not this flag set.
        let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
        let mut restricted_token = HANDLE::default();
        unsafe {
            CreateRestrictedToken(
                base_token.get(),
                flags,
                None,
                None,
                Some(&restricted),
                &mut restricted_token,
            )
            .map_err(|error| {
                SandboxError::Windows(format!("CreateRestrictedToken failed: {error}"))
            })?;
        }
        let restricted_token = HandleGuard::new(restricted_token);

        // Restricted children create their own pipes and synchronization objects. Give those
        // objects a default DACL that retains the normal identity SIDs as well as the capability
        // SID used for file writes; this mirrors the verified Codex restricted-token design.
        let dacl_sids = [logon_sid.as_psid(), world_sid.as_psid(), capability];
        let explicit = dacl_sids
            .iter()
            .map(|sid| EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL.0,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: Default::default(),
                Trustee: trustee(*sid),
            })
            .collect::<Vec<_>>();
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let acl_result = unsafe { SetEntriesInAclW(Some(&explicit), None, &mut new_dacl) };
        if acl_result.0 != 0 {
            return Err(SandboxError::Windows(format!(
                "SetEntriesInAclW for token default DACL failed: {}",
                acl_result.0
            )));
        }
        let mut default_dacl = TOKEN_DEFAULT_DACL {
            DefaultDacl: new_dacl,
        };
        let token_result = unsafe {
            SetTokenInformation(
                restricted_token.get(),
                TokenDefaultDacl,
                &mut default_dacl as *mut _ as *const _,
                std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        };
        unsafe {
            if !new_dacl.is_null() {
                let _ = LocalFree(Some(HLOCAL(new_dacl as *mut _)));
            }
        }
        token_result.map_err(|error| {
            SandboxError::Windows(format!(
                "SetTokenInformation(TokenDefaultDacl) failed: {error}"
            ))
        })?;

        enable_change_notify_privilege(restricted_token.get())?;

        Ok(restricted_token)
    }

    #[cfg(test)]
    #[test]
    fn restricted_token_creation_succeeds() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let policy = SandboxPolicy::new(
            SandboxMode::WorkspaceWrite,
            vec![workspace.path().to_path_buf()],
            Vec::new(),
            true,
        )
        .expect("test workspace policy is valid");
        let capability = capability_sid(&policy).expect("capability SID is valid");
        let token = create_restricted_token(capability.as_psid())
            .expect("CreateRestrictedToken accepts the restricting SID set");

        assert!(!token.get().is_invalid(), "restricted token is valid");
    }

    fn world_sid() -> Result<SidBytes, SandboxError> {
        let mut size = 0u32;
        unsafe {
            let _ = CreateWellKnownSid(WinWorldSid, None, None, &mut size);
        }
        if size == 0 {
            return Err(SandboxError::Windows(format!(
                "CreateWellKnownSid size query failed: {:?}",
                unsafe { GetLastError() }
            )));
        }

        let mut bytes = vec![0u8; size as usize];
        unsafe {
            CreateWellKnownSid(
                WinWorldSid,
                None,
                Some(PSID(bytes.as_mut_ptr() as *mut _)),
                &mut size,
            )
            .map_err(|error| {
                SandboxError::Windows(format!("CreateWellKnownSid failed: {error}"))
            })?;
        }
        bytes.truncate(size as usize);
        Ok(SidBytes(bytes))
    }

    fn logon_sid(token: HANDLE) -> Result<SidBytes, SandboxError> {
        let mut needed = 0u32;
        unsafe {
            let _ = GetTokenInformation(token, TokenGroups, None, 0, &mut needed);
        }
        if needed < std::mem::size_of::<TOKEN_GROUPS>() as u32 {
            return Err(SandboxError::Windows(format!(
                "TokenGroups size query failed: {:?}",
                unsafe { GetLastError() }
            )));
        }

        let mut groups = vec![0u8; needed as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenGroups,
                Some(groups.as_mut_ptr() as *mut c_void),
                needed,
                &mut needed,
            )
            .map_err(|error| {
                SandboxError::Windows(format!("GetTokenInformation(TokenGroups) failed: {error}"))
            })?;
        }

        let group_count =
            unsafe { std::ptr::read_unaligned(groups.as_ptr() as *const u32) } as usize;
        let groups_offset = {
            let after_count = groups.as_ptr() as usize + std::mem::size_of::<u32>();
            let alignment = std::mem::align_of::<SID_AND_ATTRIBUTES>();
            (after_count + alignment - 1) & !(alignment - 1)
        };
        let groups_end = groups.as_ptr() as usize + needed as usize;
        let group_size = std::mem::size_of::<SID_AND_ATTRIBUTES>();
        if groups_offset > groups_end || group_count > (groups_end - groups_offset) / group_size {
            return Err(SandboxError::Windows(
                "TokenGroups returned an invalid group array".to_string(),
            ));
        }

        let groups_ptr = groups_offset as *const SID_AND_ATTRIBUTES;
        const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
        for index in 0..group_count {
            let group = unsafe { std::ptr::read_unaligned(groups_ptr.add(index)) };
            if group.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
                let sid_length = unsafe { GetLengthSid(group.Sid) };
                if sid_length == 0 {
                    return Err(SandboxError::Windows(
                        "GetLengthSid for the logon SID failed".to_string(),
                    ));
                }
                let mut bytes = vec![0u8; sid_length as usize];
                unsafe {
                    CopySid(sid_length, PSID(bytes.as_mut_ptr() as *mut _), group.Sid).map_err(
                        |error| {
                            SandboxError::Windows(format!(
                                "CopySid for the logon SID failed: {error}"
                            ))
                        },
                    )?;
                }
                return Ok(SidBytes(bytes));
            }
        }

        Err(SandboxError::Windows(
            "the current token has no logon SID".to_string(),
        ))
    }

    fn enable_change_notify_privilege(token: HANDLE) -> Result<(), SandboxError> {
        let privilege_name = wide("SeChangeNotifyPrivilege");
        let mut luid = LUID::default();
        unsafe {
            LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(privilege_name.as_ptr()), &mut luid)
                .map_err(|error| {
                    SandboxError::Windows(format!(
                        "LookupPrivilegeValueW(SeChangeNotifyPrivilege) failed: {error}"
                    ))
                })?;
        }

        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        unsafe {
            AdjustTokenPrivileges(token, false, Some(&privileges as *const _), 0, None, None)
                .map_err(|error| {
                    SandboxError::Windows(format!(
                        "AdjustTokenPrivileges(SeChangeNotifyPrivilege) failed: {error}"
                    ))
                })?;
            let error = GetLastError();
            if error.0 != 0 {
                return Err(SandboxError::Windows(format!(
                    "AdjustTokenPrivileges(SeChangeNotifyPrivilege) returned {error:?}"
                )));
            }
        }
        Ok(())
    }

    fn create_job() -> Result<HandleGuard, SandboxError> {
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| SandboxError::Windows(format!("CreateJobObjectW failed: {error}")))?;
        let job = HandleGuard::new(job);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT(
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION.0,
        );
        unsafe {
            SetInformationJobObject(
                job.get(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|error| {
                SandboxError::Windows(format!("SetInformationJobObject failed: {error}"))
            })?;
        }
        Ok(job)
    }

    fn capture_acl(path: &Path) -> Result<AclSnapshot, SandboxError> {
        let wide_path = wide(&path.to_string_lossy());
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut security_descriptor = PSECURITY_DESCRIPTOR::default();
        let result = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut security_descriptor,
            )
        };
        if result.0 != 0 {
            return Err(SandboxError::Windows(format!(
                "GetNamedSecurityInfoW failed for {}: {}",
                path.display(),
                result.0
            )));
        }
        let dacl_copy = if dacl.is_null() {
            None
        } else {
            let size = unsafe { (*dacl).AclSize as usize };
            if size < std::mem::size_of::<ACL>() {
                unsafe {
                    if !security_descriptor.is_invalid() {
                        let _ = LocalFree(Some(HLOCAL(security_descriptor.0)));
                    }
                }
                return Err(SandboxError::Windows(format!(
                    "invalid DACL returned for {}",
                    path.display()
                )));
            }
            Some(unsafe { slice::from_raw_parts(dacl as *const u8, size) }.to_vec())
        };
        unsafe {
            if !security_descriptor.is_invalid() {
                let _ = LocalFree(Some(HLOCAL(security_descriptor.0)));
            }
        }
        Ok(AclSnapshot {
            path: path.to_path_buf(),
            dacl: dacl_copy,
        })
    }

    fn add_acl_entry(
        path: &Path,
        sid: PSID,
        permissions: u32,
        access_mode: windows::Win32::Security::Authorization::ACCESS_MODE,
    ) -> Result<(), SandboxError> {
        let wide_path = wide(&path.to_string_lossy());
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut security_descriptor = PSECURITY_DESCRIPTOR::default();
        let result = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old_dacl),
                None,
                &mut security_descriptor,
            )
        };
        if result.0 != 0 {
            return Err(SandboxError::Windows(format!(
                "GetNamedSecurityInfoW failed for {}: {}",
                path.display(),
                result.0
            )));
        }

        let explicit = EXPLICIT_ACCESS_W {
            grfAccessPermissions: permissions,
            grfAccessMode: access_mode,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: trustee(sid),
        };
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let acl_result = unsafe {
            SetEntriesInAclW(
                Some(std::slice::from_ref(&explicit)),
                (!old_dacl.is_null()).then_some(old_dacl as *const ACL),
                &mut new_dacl,
            )
        };
        if acl_result.0 != 0 {
            unsafe {
                if !security_descriptor.is_invalid() {
                    let _ = LocalFree(Some(HLOCAL(security_descriptor.0)));
                }
            }
            return Err(SandboxError::Windows(format!(
                "SetEntriesInAclW failed for {}: {}",
                path.display(),
                acl_result.0
            )));
        }

        let set_result = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(new_dacl as *const ACL),
                None,
            )
        };
        unsafe {
            if !new_dacl.is_null() {
                let _ = LocalFree(Some(HLOCAL(new_dacl as *mut _)));
            }
            if !security_descriptor.is_invalid() {
                let _ = LocalFree(Some(HLOCAL(security_descriptor.0)));
            }
        }
        if set_result.0 != 0 {
            return Err(SandboxError::Windows(format!(
                "SetNamedSecurityInfoW failed for {}: {}",
                path.display(),
                set_result.0
            )));
        }
        Ok(())
    }

    fn trustee(sid: PSID) -> TRUSTEE_W {
        TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: Default::default(),
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: windows::core::PWSTR(sid.0 as *mut u16),
        }
    }

    fn command_line(command: &str, args: &[String]) -> (String, Vec<u16>) {
        let direct = once(command.to_string())
            .chain(args.iter().cloned())
            .map(|argument| quote_windows_arg(&argument))
            .collect::<Vec<_>>()
            .join(" ");
        if command.to_ascii_lowercase().ends_with(".cmd")
            || command.to_ascii_lowercase().ends_with(".bat")
        {
            let shell = std::env::var("ComSpec")
                .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string());
            let command_line = format!("/d /s /c {}", quote_windows_arg(&direct));
            return (shell, wide(&command_line));
        }
        (command.to_string(), wide(&direct))
    }

    fn quote_windows_arg(argument: &str) -> String {
        if !argument.is_empty()
            && !argument
                .chars()
                .any(|character| character.is_whitespace() || character == '"')
        {
            return argument.to_string();
        }

        let mut quoted = String::with_capacity(argument.len() + 2);
        quoted.push('"');
        let mut backslashes = 0usize;
        for character in argument.chars() {
            if character == '\\' {
                backslashes += 1;
                continue;
            }
            if character == '"' {
                quoted.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                quoted.push('"');
            } else {
                quoted.extend(std::iter::repeat('\\').take(backslashes));
                quoted.push(character);
            }
            backslashes = 0;
        }
        quoted.extend(std::iter::repeat('\\').take(backslashes * 2));
        quoted.push('"');
        quoted
    }

    fn startup_info() -> STARTUPINFOW {
        STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        }
    }

    fn configure_stdio(startup: &mut STARTUPINFOW) -> bool {
        let Ok(input) = (unsafe { GetStdHandle(STD_INPUT_HANDLE) }) else {
            return false;
        };
        let Ok(output) = (unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }) else {
            return false;
        };
        let Ok(error) = (unsafe { GetStdHandle(STD_ERROR_HANDLE) }) else {
            return false;
        };
        let handles = [input, output, error];
        for handle in handles {
            if handle.is_invalid()
                || unsafe {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
                }
                .is_err()
            {
                return false;
            }
        }
        startup.dwFlags |= STARTF_USESTDHANDLES;
        startup.hStdInput = handles[0];
        startup.hStdOutput = handles[1];
        startup.hStdError = handles[2];
        true
    }

    fn decode_policy(encoded: &str) -> Result<SandboxPolicy, SandboxError> {
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|error| SandboxError::PolicyDecode(error.to_string()))?;
        let decoded: SandboxPolicy = serde_json::from_slice(&bytes)
            .map_err(|error| SandboxError::PolicyDecode(error.to_string()))?;
        SandboxPolicy::new(
            decoded.mode,
            decoded.workspace_roots,
            decoded.deny_read,
            decoded.network_enabled,
        )
        .map_err(|error| SandboxError::PolicyDecode(error.to_string()))
    }

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(once(0))
            .collect()
    }

    fn exit_with(code: i32, message: impl std::fmt::Display) -> ! {
        eprintln!("Seren Windows sandbox launcher: {message}");
        process::exit(code);
    }
}

#[cfg(windows)]
pub use platform::{apply_and_spawn_contained, sandbox_run_main};

#[cfg(not(windows))]
pub fn apply_and_spawn_contained(
    _policy: &super::policy::SandboxPolicy,
    _command: &str,
    _args: &[String],
) -> Result<i32, super::policy::SandboxError> {
    Err(super::policy::SandboxError::BackendUnavailable)
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn sandbox_run_main(_args: Vec<String>) -> ! {
    std::process::exit(78)
}
