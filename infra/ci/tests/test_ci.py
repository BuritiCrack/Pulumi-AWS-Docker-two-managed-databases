"""Run the public Node CLI/workflow fixtures through the authorized offline suite."""
import pathlib
import subprocess
import unittest


class CiContractTests(unittest.TestCase):
    def test_public_cli_and_workflow(self):
        root = pathlib.Path(__file__).resolve().parents[3]
        tests = sorted((root / "infra/ci/tests").glob("*.test.cjs"))
        result = subprocess.run(
            ["node", "--test", *map(str, tests)], cwd=root,
            capture_output=True, text=True, timeout=120, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
