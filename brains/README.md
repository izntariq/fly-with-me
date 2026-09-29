# brains/: CC BY-NC 4.0, not Apache-2.0

Everything in this folder is derived from FlyWire data and is distributed under the
[Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/)
licence, with attribution to FlyWire (Princeton University and the FlyWire Consortium, https://flywire.ai). It may
not be used commercially. The rest of the repository's code is Apache-2.0; that licence does not cover these files.

| File | What it holds |
|---|---|
| `trained_brain.npz` | `K`, the indices of the FlyWire v783 synapses that training changed; `w0`, their original FlyWire weights; `weights`, the trained weights. Loaded by the server unless `--brain naive` |
| `readout.json` | the trained readout: FlyWire root IDs of the neurons that signal each section (`experiments/readout.py`) |
| `recruited_neurons.json` | FlyWire root IDs, per section and side, of the neurons training recruited |
| `sections_trained.json` | the section sense, fitted on a listener fly's outputs with section labels from the All-In-One analyzer (`tools/train_sections.py`). Model coefficients only: no audio, no track names |
| `training_log*.json` | the training runs' numbers (`flybrain/train.py`) |

Changes were made: the weights are this project's retraining of the FlyWire connectome's synapse weights.

If you use these files, cite FlyWire as listed in [NOTICE](../NOTICE):
Dorkenwald S. et al. (2024) *Neuronal wiring diagram of an adult brain*, Nature;
Schlegel P. et al. (2024) *Whole-brain annotation and multi-connectome cell typing of Drosophila*, Nature;
and the model they run on, Shiu P.K. et al. (2024) *A Drosophila computational brain model reveals sensorimotor
processing*, Nature.
