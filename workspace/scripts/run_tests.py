import os
import sys
import glob
import json
import subprocess

def run_all_tests():
    test_files = sorted(glob.glob("tests/validation/*.py"))
    results = []

    print(f"Discovered {len(test_files)} validation tests.")
    for test_file in test_files:
        print(f"Running {test_file}...")
        proc = subprocess.run(
            [sys.executable, test_file],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        if proc.returncode != 0:
            print(f"Error running {test_file}: {proc.stderr}")
            # Try to see if valid json was emitted or record failure
            try:
                res = json.loads(proc.stdout.strip())
                results.append(res)
            except Exception:
                results.append({
                    "test_name": os.path.basename(test_file),
                    "score": 0,
                    "comment": f"Process exited with code {proc.returncode}: {proc.stderr.strip()}"
                })
        else:
            try:
                res = json.loads(proc.stdout.strip())
                results.append(res)
                print(f"  Result: {res}")
            except Exception as e:
                print(f"Failed to parse JSON output: {proc.stdout}")
                results.append({
                    "test_name": os.path.basename(test_file),
                    "score": 0,
                    "comment": f"Invalid JSON output: {proc.stdout.strip()}"
                })

    out_file = os.path.join("web-report", "data", "test_results.json")
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2)

    print(f"Saved {len(results)} test result(s) to {out_file}")

if __name__ == "__main__":
    run_all_tests()
