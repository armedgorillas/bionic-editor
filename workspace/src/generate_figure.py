import os
import numpy as np
import matplotlib.pyplot as plt

def generate_sample_figure():
    os.makedirs("figures", exist_ok=True)
    
    # Generate synthetic analytical signal data
    t = np.linspace(0, 10, 500)
    signal = np.exp(-0.2 * t) * np.cos(2 * np.pi * 0.5 * t)
    
    # Create plot
    fig, ax = plt.subplots(figsize=(7, 4), dpi=150)
    ax.plot(t, signal, color="#2563eb", linewidth=2, label="Damped Oscillation")
    ax.fill_between(t, signal, color="#93c5fd", alpha=0.3)
    
    # Formatting
    ax.set_title("Sample Analytical Signal", fontsize=14, fontweight="bold", pad=12)
    ax.set_xlabel("Time (s)", fontsize=11)
    ax.set_ylabel("Amplitude (a.u.)", fontsize=11)
    ax.grid(True, linestyle="--", alpha=0.5)
    ax.legend(frameon=True, loc="upper right")
    
    plt.tight_layout()
    output_path = os.path.join("figures", "sample_figure.png")
    fig.savefig(output_path, dpi=300)
    plt.close(fig)
    print(f"Figure saved successfully to {output_path}")

if __name__ == "__main__":
    generate_sample_figure()
