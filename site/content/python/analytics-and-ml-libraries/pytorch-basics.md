# PyTorch Basics

> **Why a quant must own this:** PyTorch is the dominant deep-learning framework
> in research and increasingly in production quant — sequence models on order
> flow, attention models on alt-data, differentiable pricing/optimization. Its
> define-by-run autograd makes the *mental model* explicit: tensors carry
> gradients, the backward pass walks a dynamically-built graph. Mastering the
> tensor/`autograd`/`nn.Module`/optimizer loop — and the leakage and overfitting
> traps that apply doubly to financial data — is the capstone of this track.

## First principles: tensors with gradients

A PyTorch **tensor** is an n-D array (NumPy-like) that can live on a GPU and,
when `requires_grad=True`, records the operations applied to it so gradients can
be computed by **reverse-mode autodiff**. PyTorch builds the computation graph
*dynamically* as your Python code runs ("define-by-run") — so control flow
(loops, `if`) is just normal Python, which makes debugging far easier than a
static graph.

```python
import torch

x = torch.tensor([[1., 2.], [3., 4.]])          # rank-2 float32 tensor
print(x.shape, x.dtype, x.device)                # torch.Size([2,2]) float32 cpu

# interop with NumPy (shares memory on CPU -- a view, not a copy!)
import numpy as np
a = np.ones(3)
t = torch.from_numpy(a)                          # shares buffer with a
a[0] = 99.0
print(t)                                          # tensor([99., 1., 1.]) -- aliased!
```

> Like TensorFlow, PyTorch defaults to **`float32`** (vs NumPy's `float64`).
> And note `torch.from_numpy` **shares memory** — a view/copy gotcha straight
> from the NumPy lesson: mutating one mutates the other.

## `autograd`: gradients by recording the graph

Set `requires_grad=True`, run the forward computation, call `.backward()` on a
scalar loss, and PyTorch populates each leaf tensor's `.grad`.

```python
w = torch.tensor(0.0, requires_grad=True)        # trainable parameter
b = torch.tensor(0.0, requires_grad=True)
xs = torch.tensor([1., 2., 3., 4.])
ys = torch.tensor([2., 4., 6., 8.])              # target: y = 2x

pred = w * xs + b
loss = ((pred - ys) ** 2).mean()                 # MSE (a scalar)
loss.backward()                                   # reverse-mode autodiff
print(w.grad, b.grad)                             # dLoss/dw, dLoss/db
```

`.backward()` accumulates into `.grad`, so you must **zero gradients each step**
(`optimizer.zero_grad()`) — forgetting this is the single most common PyTorch
bug, silently summing gradients across iterations.

## The canonical training loop

```python
import torch
from torch import nn

model = nn.Sequential(
    nn.Linear(n_features, 64), nn.ReLU(), nn.Dropout(0.2),
    nn.Linear(64, 1),                             # regression head
)
loss_fn = nn.MSELoss()
opt = torch.optim.Adam(model.parameters(), lr=1e-3)

for epoch in range(50):
    for xb, yb in train_loader:                   # mini-batches from a DataLoader
        opt.zero_grad()                           # 1. clear old gradients
        pred = model(xb)                          # 2. forward
        loss = loss_fn(pred, yb)                  # 3. compute loss
        loss.backward()                           # 4. backprop -> fills .grad
        opt.step()                                # 5. update params from gradients
```

```text
   zero_grad → forward(model) → loss → backward() → step()   (repeat per batch)
        ▲                                                  │
        └──────────────── next iteration ◀────────────────┘
```

Memorize these five lines; every PyTorch model trains with this skeleton.

## `nn.Module`, `DataLoader`, and device placement

```python
class ReturnNet(nn.Module):
    def __init__(self, n_in):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(n_in, 32), nn.ReLU(), nn.Linear(32, 1))
    def forward(self, x):
        return self.net(x)

device = "cuda" if torch.cuda.is_available() else "cpu"
model = ReturnNet(n_features).to(device)          # move params to GPU

from torch.utils.data import TensorDataset, DataLoader
ds = TensorDataset(torch.from_numpy(X).float(), torch.from_numpy(y).float())
loader = DataLoader(ds, batch_size=256, shuffle=False)   # shuffle=False for time series!
```

You must `.to(device)` both the model and each batch; a CPU/GPU mismatch raises a
runtime error. `shuffle` defaults to `False` here deliberately — see the gotchas.

## Inference: `eval()` and `no_grad()`

```python
model.eval()                                      # disable dropout/batchnorm training behavior
with torch.no_grad():                             # don't build the graph -> faster, less memory
    preds = model(torch.from_numpy(X_test).float().to(device))
```

`no_grad()` is the inference counterpart to a context manager (cf. the
context-managers lesson) — it turns off gradient tracking for a block, saving
memory and time. `model.eval()` switches layers like Dropout/BatchNorm into
inference mode; forgetting it silently corrupts predictions.

## PyTorch vs TensorFlow — the mental model

| Aspect            | PyTorch                       | TensorFlow / Keras                  |
|-------------------|-------------------------------|-------------------------------------|
| Graph             | dynamic (define-by-run)       | eager + `@tf.function` (graph)      |
| Gradient API      | `loss.backward()` + `.grad`   | `GradientTape`                      |
| Zero grads        | explicit `zero_grad()`        | tape resets each context            |
| Compile for speed | `torch.compile` (2.0+)        | `@tf.function`                      |
| Default dtype     | `float32`                     | `float32`                           |

The underlying ideas — tensors, reverse-mode autodiff, optimizers, GPU
placement, float32 — are identical. Skills transfer directly.

## Performance reality

- **GPU is the win** for matmul-heavy models, but CPU↔GPU transfers are costly:
  move data with `.to(device, non_blocking=True)`, keep it resident, and use
  `DataLoader(num_workers=...)`/`pin_memory=True` to overlap loading with
  compute.
- **`torch.compile(model)`** (PyTorch 2.x) JIT-compiles the graph for substantial
  speedups — the same eager-vs-compiled trade-off as `@tf.function` and Numba.
- **Mixed precision** (`torch.autocast` + `GradScaler`) uses `float16`/`bfloat16`
  for big speed/memory gains on modern GPUs.
- **`no_grad()` at inference** roughly halves memory (no saved activations) and
  speeds it up — always use it for prediction.
- DL remains **overkill for small, weak-signal tabular** quant data; gradient-
  boosted trees or linear models (sklearn lesson) usually win there. Reserve
  PyTorch for sequence/large-data problems.

## Quant relevance & interview gotchas

- **Forgetting `optimizer.zero_grad()`** — gradients accumulate across steps,
  training diverges or stalls. The #1 PyTorch bug.
- **`shuffle=True` on time-ordered data** leaks the future into training — the
  same sequential-CV/lookahead discipline from the sklearn lesson. Split and
  window by time.
- **Train/eval mode and `no_grad`** at inference: forgetting `model.eval()`
  leaves Dropout active and gives noisy, wrong predictions.
- **`from_numpy` aliases memory** — mutating the array after wrapping it silently
  changes the tensor (a view/copy bug).
- **Overfitting tiny signal:** financial SNR is low; a high-capacity net memorizes
  noise. Regularize (dropout, weight decay, early stopping) and judge on
  out-of-sample.
- **GPU nondeterminism / seeding:** set `torch.manual_seed`; full determinism may
  need `torch.use_deterministic_algorithms(True)` and still varies across
  hardware — relevant when a result "won't reproduce exactly."
- Interview ask: "write a PyTorch training loop" — they want the five steps
  (`zero_grad`/forward/loss/`backward`/`step`) and awareness of `eval`/`no_grad`.

## Key takeaways

1. A PyTorch tensor is a GPU-capable, gradient-tracking n-D array; default dtype
   `float32`, and `from_numpy` shares memory.
2. Autograd is define-by-run: forward builds the graph dynamically, `.backward()`
   computes gradients into `.grad`.
3. The training loop is `zero_grad → forward → loss → backward → step`; you
   **must** zero gradients each iteration.
4. Use `nn.Module`/`DataLoader`, move model and data with `.to(device)`, and
   wrap inference in `model.eval()` + `torch.no_grad()`.
5. `torch.compile` and mixed precision accelerate; keep data resident on the GPU.
6. Apply the same anti-lookahead/anti-overfitting discipline as classical ML —
   never `shuffle` time-ordered data; validate out-of-sample.

## Self-check

1. What happens if you omit `optimizer.zero_grad()` in the training loop, and
   why?
2. Write the five canonical steps of a PyTorch training iteration in order.
3. Why does `torch.from_numpy(a)` create an aliasing hazard, and how is it like
   the NumPy view/copy issue?
4. What do `model.eval()` and `torch.no_grad()` each do at inference, and what
   breaks if you forget them?
5. Why is `shuffle=True` in a `DataLoader` dangerous for a financial time series?
6. Name the PyTorch analogue of TensorFlow's `@tf.function` and what it does.

## Further reading

- [PyTorch tutorials: Learn the Basics](https://pytorch.org/tutorials/beginner/basics/intro.html) and [Autograd mechanics](https://pytorch.org/docs/stable/notes/autograd.html).
- [What is `torch.nn` really? — PyTorch tutorial](https://pytorch.org/tutorials/beginner/nn_tutorial.html).
- [`torch.compile` tutorial](https://pytorch.org/tutorials/intermediate/torch_compile_tutorial.html) and [Automatic mixed precision](https://pytorch.org/docs/stable/amp.html).
- [Bridge with NumPy](https://pytorch.org/tutorials/beginner/blitz/tensor_tutorial.html#bridge-to-np-label) (shared-memory gotcha).
- Aurélien Géron, *Hands-On Machine Learning*, 3rd ed. (DL chapters); Stevens et al., *Deep Learning with PyTorch*.

## Videos

- PyTorch — **"PyTorch in 100 seconds"** / official **"PyTorch Fundamentals"** ([search](https://www.youtube.com/results?search_query=PyTorch+fundamentals+official+tutorial)).
- PyData — **"Deep learning with PyTorch for time series / finance"** ([search](https://www.youtube.com/results?search_query=PyData+PyTorch+time+series+finance)).
