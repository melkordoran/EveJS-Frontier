#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <wchar.h>

typedef int (__cdecl *py_bytes_main_fn)(int, char **);

static int utf8_to_wide(const char *input, wchar_t *output, int output_count) {
    return MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        input,
        -1,
        output,
        output_count
    );
}

int main(int argc, char **argv) {
    wchar_t dll_path[32768];
    wchar_t dll_directory[32768];
    HMODULE python_dll;
    py_bytes_main_fn py_bytes_main;
    wchar_t *last_separator;

    if (argc < 3) {
        fputs("usage: frontier-python312-runner.exe <python312.dll> <script> [args...]\n", stderr);
        return 2;
    }
    if (!utf8_to_wide(argv[1], dll_path, (int)(sizeof(dll_path) / sizeof(dll_path[0])))) {
        fputs("could not decode the python312.dll path as UTF-8\n", stderr);
        return 3;
    }
    lstrcpynW(dll_directory, dll_path, (int)(sizeof(dll_directory) / sizeof(dll_directory[0])));
    last_separator = wcsrchr(dll_directory, L'\\');
    if (last_separator == NULL) {
        last_separator = wcsrchr(dll_directory, L'/');
    }
    if (last_separator == NULL) {
        fputs("python312.dll path has no directory\n", stderr);
        return 4;
    }
    *last_separator = L'\0';

    if (!SetDefaultDllDirectories(
            LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS)) {
        fputs("SetDefaultDllDirectories failed\n", stderr);
        return 5;
    }
    if (AddDllDirectory(dll_directory) == NULL) {
        fputs("AddDllDirectory failed\n", stderr);
        return 6;
    }
    python_dll = LoadLibraryExW(
        dll_path,
        NULL,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
            LOAD_LIBRARY_SEARCH_DEFAULT_DIRS |
            LOAD_LIBRARY_SEARCH_USER_DIRS
    );
    if (python_dll == NULL) {
        fprintf(stderr, "LoadLibraryExW failed with error %lu\n", GetLastError());
        return 7;
    }
    py_bytes_main = (py_bytes_main_fn)GetProcAddress(python_dll, "Py_BytesMain");
    if (py_bytes_main == NULL) {
        fputs("python312.dll does not export Py_BytesMain\n", stderr);
        FreeLibrary(python_dll);
        return 8;
    }

    /* argv[1] becomes Python's executable name and argv[2] its script path. */
    return py_bytes_main(argc - 1, argv + 1);
}
