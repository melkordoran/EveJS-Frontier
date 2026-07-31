extern int Py_BytesMain(int argc, char **argv);

int main(int argc, char **argv) {
    if (argc < 2) {
        return 2;
    }
    return Py_BytesMain(argc, argv);
}
