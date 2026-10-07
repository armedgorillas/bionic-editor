import json
import os
import sys

def main():
    data_path = os.path.join("web-report", "data", "umap_data.json")
    if not os.path.exists(data_path):
        result = {
            "test_name": "Label Count Consistency",
            "score": 0,
            "comment": f"Data file not found at {data_path}"
        }
        print(json.dumps(result))
        sys.exit(1)

    with open(data_path, "r") as f:
        data = json.load(f)

    author_labels = set(data.get("author_label_idx", []))
    pred_labels = set(data.get("pred_label_idx", []))

    num_author = len(author_labels)
    num_pred = len(pred_labels)

    passed = (num_author == num_pred) and (num_author > 0)
    score = 1 if passed else 0

    comment = f"Found {num_author} author types and {num_pred} predicted types."

    result = {
        "test_name": "Label Count Consistency",
        "score": score,
        "comment": comment
    }
    print(json.dumps(result))

if __name__ == "__main__":
    main()
